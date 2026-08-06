"""Ultralytics training (doc 08 §12, §23-25; doc 07 §22-25 training model registration).

Flow: claim execution → QUEUED→PREPARING→RUNNING → real Ultralytics train on CPU/GPU →
best.pt dual-store (MinIO artifact + Model Root copy) → last.pt discarded → register a
TRAINING-source model → RUNNING→COMPLETED with result_model_id. All training_jobs status
changes are guarded conditional UPDATEs (the Node state machine cannot be called cross-language).
"""
import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import uuid

import psycopg

from . import log
from .heartbeat import Heartbeat
from .model_cache import fetch_model_file
from .run_outputs import upload_run_outputs


class TrainingError(Exception):
    def __init__(self, stage: str, code: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message


class TrainingStopped(Exception):
    """Raised when the user requested a stop and training halted early."""


class _TeeToFile(io.StringIO):
    """Buffers writes in memory (like the plain StringIO this replaces) but also
    appends every write to a file on disk immediately, so the log is readable from
    disk mid-training instead of only after model.train() returns."""

    def __init__(self, path: str) -> None:
        super().__init__()
        self._fh = open(path, "w", encoding="utf-8")

    def write(self, s: str) -> int:
        self._fh.write(s)
        self._fh.flush()
        return super().write(s)

    def close(self) -> None:
        self._fh.close()
        super().close()


def _sanitize(name: str) -> str:
    slug = re.sub(r"\s+", "-", name.strip())
    slug = re.sub(r"[^A-Za-z0-9._-]", "", slug).strip("-._")
    return slug or "model"


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class Trainer:
    def __init__(self, conn, storage, cfg) -> None:
        self.conn = conn
        self.storage = storage
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        job_id = payload["training_job_id"]
        job_execution_id = payload["job_execution_id"]
        assignment_token = payload["assignment_token"]
        correlation_id = payload.get("correlation_id")
        log.info("training dispatched", training_job_id=job_id, job_execution_id=job_execution_id)

        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE job_executions SET status='CLAIMED', claimed_at=now() "
                "WHERE id=%s AND assignment_token=%s AND status='ASSIGNED' RETURNING id",
                (job_execution_id, assignment_token),
            )
            if cur.fetchone() is None:
                log.warn("training execution not claimable", job_execution_id=job_execution_id)
                return
            cur.execute("UPDATE job_executions SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=%s", (job_execution_id,))
            cur.execute(
                "UPDATE training_jobs SET status='PREPARING', preparing_at=now(), row_version=row_version+1, updated_at=now() "
                "WHERE id=%s AND status='QUEUED' RETURNING id",
                (job_id,),
            )
            if cur.fetchone() is None:
                log.warn("training job not in QUEUED (already handled/cancelled)", training_job_id=job_id)
                self.conn.rollback()
                cur.execute("UPDATE job_executions SET status='CANCELLED', finished_at=now() WHERE id=%s", (job_execution_id,))
                self.conn.commit()
                return
        self.conn.commit()

        ctx = self._load(job_id)
        work_dir = os.path.join(ctx["model_root_host"], ".training", job_id)
        model_root_path = None
        try:
            self._audit(job_id, correlation_id, "TRAINING_JOB_PREPARING", "SUCCESS", {"from": "QUEUED", "to": "PREPARING"})
            with self.conn.cursor() as cur:
                cur.execute(
                    "UPDATE training_jobs SET status='RUNNING', started_at=now(), row_version=row_version+1, updated_at=now() "
                    "WHERE id=%s AND status='PREPARING' RETURNING id",
                    (job_id,),
                )
                if cur.fetchone() is None:
                    raise TrainingError("PREPARATION", "TRAINING_STATE_LOST", "job left PREPARING unexpectedly")
            self.conn.commit()
            self._audit(job_id, correlation_id, "TRAINING_JOB_RUNNING", "SUCCESS", {"from": "PREPARING", "to": "RUNNING"})

            with Heartbeat(self.cfg.pg_conninfo(), job_execution_id, self.cfg.heartbeat_interval_s):
                best_pt = self._train(ctx, work_dir, job_id, job_execution_id)
            run_base = os.path.join(work_dir, "run")
            result = self._store_and_register(ctx, job_id, job_execution_id, correlation_id, best_pt, run_base)
            model_root_path = result.get("model_root_path")
            self._complete(ctx, job_id, job_execution_id, correlation_id, result)
        except TrainingStopped:
            self._stopped(ctx, job_id, job_execution_id, correlation_id)
        except TrainingError as te:
            self._fail(ctx, job_id, job_execution_id, correlation_id, te.stage, te.code, te.message)
        except Exception as e:  # noqa: BLE001
            self._fail(ctx, job_id, job_execution_id, correlation_id, "TRAINING", "TRAINING_FAILED", str(e)[:500])
        finally:
            # Keep MinIO as the only long-term store for trained weights: wipe the run dir
            # and drop the Model Root copy (re-downloaded on demand for training/benchmark).
            shutil.rmtree(work_dir, ignore_errors=True)
            if model_root_path and os.path.isfile(model_root_path):
                try:
                    os.remove(model_root_path)
                    log.info("model root copy removed", path=model_root_path)
                except OSError as e:  # noqa: PERF203
                    log.warn("model root copy removal failed", path=model_root_path, error=str(e)[:200])

    def _load(self, job_id: str) -> dict:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT d.task_type, d.dataset_type_id, d.relative_path, "
                "dt.model_path, dt.training_dataset_path, "
                "tj.name, tj.hyperparameters, tj.created_by_user_id, tj.training_dataset_id, "
                "tj.base_model_id, m.relative_path, m.model_path, "
                "a.bucket_name, a.object_key, a.checksum "
                "FROM training_jobs tj "
                "JOIN training_datasets d ON d.id = tj.training_dataset_id "
                "JOIN dataset_types dt ON dt.id = d.dataset_type_id "
                "LEFT JOIN models m ON m.id = tj.base_model_id "
                "LEFT JOIN artifacts a ON a.id = m.source_artifact_id AND a.artifact_type_code='BEST_MODEL' "
                "WHERE tj.id=%s",
                (job_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise TrainingError("VALIDATION", "TRAINING_JOB_NOT_FOUND", "training job not found")
            (task_type, dataset_type_id, ds_rel, model_root_host, training_dataset_path,
             name, hp, created_by, dataset_id, base_model_id, base_rel, base_model_path,
             base_bucket, base_key, base_checksum) = row

            if not model_root_host:
                raise TrainingError("DATASET_TYPE", "MODEL_ROOT_NOT_FOUND", "dataset type has no model_path configured")

        hp = hp if isinstance(hp, dict) else {}
        # Every training dataset — built or registered — lives under the type's
        # training_dataset_path. model_path is only for model files.
        if not training_dataset_path:
            raise TrainingError("DATASET_TYPE", "TD_PATH_NOT_SET", "dataset type has no training_dataset_path configured")
        data_yaml = os.path.join(training_dataset_path, ds_rel, "data.yaml")
        ctx = {
            "name": name, "hp": hp, "created_by": created_by,
            "training_dataset_id": str(dataset_id) if dataset_id else None,
            "base_model_id": str(base_model_id) if base_model_id else None,
            "task_type": task_type, "dataset_type_id": str(dataset_type_id),
            "data_yaml": data_yaml,
            "model_root_host": model_root_host,
        }
        if base_model_id and base_rel:
            ctx["base_pt"] = base_model_path or os.path.join(model_root_host, base_rel)
            ctx["base_artifact"] = (base_bucket, base_key, base_checksum)
        else:
            ctx["base_pt"] = None
            ctx["base_artifact"] = (None, None, None)
        return ctx

    # Ultralytics weight names differ by generation: v8/v9/v10 keep the "v", 11/12/26 drop it.
    # Mirrors YOLO_VERSIONS in NewTrainingWizard.tsx — keep the two in step.
    TASK_SUFFIX = {"OBB": "-obb", "DETECT": "", "POSE": "-pose", "SEGMENT": "-seg", "CLASSIFY": "-cls"}
    _VERSIONS_KEEP_V = {"v8", "v9", "v10"}

    @staticmethod
    def _default_model_name(task_type: str) -> str:
        return f"yolov8n{Trainer.TASK_SUFFIX.get(task_type, '')}.pt"

    @staticmethod
    def _official_model_name(version: str, size: str, task_type: str) -> str:
        stem = f"yolo{version}{size}" if version in Trainer._VERSIONS_KEEP_V else f"yolo{version.lstrip('v')}{size}"
        return f"{stem}{Trainer.TASK_SUFFIX.get(task_type, '')}.pt"

    # Arguments the platform owns. Letting a job set these would point training at other
    # data, write outside its workspace, or resume an unrelated run.
    _RESERVED_ARGS = frozenset({
        "data", "project", "name", "save_dir", "exist_ok", "resume", "mode", "task",
    })
    # Passed explicitly by _train and therefore not taken from hyperparameters.
    _EXPLICIT_ARGS = frozenset({"epochs", "imgsz", "batch"})
    # Consumed by the platform, never forwarded to train(). `model` is how the wizard
    # records which official weight to start from — _resolve_base_weights reads it and
    # rejects anything path-like — so it must be accepted here, not treated as reserved.
    _WIZARD_ARGS = frozenset({"model", "yolo_version", "yolo_size"})

    def _train_overrides(self, hp: dict) -> dict:
        """Everything from `hyperparameters` that should reach `model.train()`.

        Until now only epochs/imgsz/batch were forwarded, so every optimizer,
        augmentation and regularisation control in the wizard was stored and then
        ignored. They are passed through here, validated first with Ultralytics' own
        `check_cfg` so a bad value fails during PREPARATION with its message rather than
        part-way through a run.
        """
        try:
            from ultralytics.cfg import DEFAULT_CFG_DICT, check_cfg
        except Exception as e:  # noqa: BLE001
            raise TrainingError("PREPARATION", "TRAINING_RUNTIME_UNAVAILABLE",
                                f"ultralytics config unavailable: {e}")

        overrides, rejected = {}, []
        for key, value in (hp or {}).items():
            if key in self._EXPLICIT_ARGS or key in self._WIZARD_ARGS:
                continue
            if key in self._RESERVED_ARGS:
                rejected.append(f"{key} (set by the platform)")
                continue
            if key not in DEFAULT_CFG_DICT:
                rejected.append(f"{key} (not a YOLO training argument)")
                continue
            overrides[key] = value

        if rejected:
            raise TrainingError("PREPARATION", "TRAINING_INVALID_HYPERPARAMETERS",
                                "unusable hyperparameters: " + ", ".join(sorted(rejected)))
        try:
            # Validate alongside the values _train passes itself, since some checks are
            # only meaningful in combination.
            check_cfg({**overrides, "epochs": hp.get("epochs", 100),
                       "imgsz": hp.get("imgsz", 640), "batch": hp.get("batch", 16)}, hard=True)
        except Exception as e:  # noqa: BLE001
            raise TrainingError("PREPARATION", "TRAINING_INVALID_HYPERPARAMETERS", str(e)[:400])
        return overrides

    def _resolve_base_weights(self, ctx: dict) -> str:
        """A registered base model wins; otherwise honour the official version/size the
        wizard recorded in hyperparameters, falling back to the historical default."""
        hp = ctx.get("hp") or {}
        name = hp.get("model")
        if name:
            # Only a bare weight name is accepted here — a path would let a job read an
            # arbitrary file off the worker.
            if "/" in str(name) or "\\" in str(name):
                raise TrainingError("PREPARATION", "TRAINING_MODEL_NAME_INVALID",
                                    f"hyperparameters.model must be a weight name, got {name!r}")
            return str(name)
        version, size = hp.get("yolo_version"), hp.get("yolo_size")
        if version and size:
            return self._official_model_name(str(version), str(size), ctx["task_type"])
        return self._default_model_name(ctx["task_type"])

    @staticmethod
    def _weights_cache_dir() -> str:
        return os.environ.get("YOLO_WEIGHTS_CACHE", "/opt/yolo-weights")

    def _cached_official_weights(self, name: str) -> str:
        """Return an absolute path to the cached weight file when it is already present,
        so a repeat job (or an air-gapped worker with a pre-seeded cache) never reaches
        for the network. On a miss the bare name is returned and Ultralytics downloads
        it; the result is then filed into the cache for next time."""
        cache = self._weights_cache_dir()
        try:
            os.makedirs(cache, exist_ok=True)
        except OSError:
            return name
        hit = os.path.join(cache, name)
        if os.path.isfile(hit):
            log.info("using cached pretrained weights", weights=hit)
            return hit
        self._pending_cache = (name, hit)
        return name

    def _file_downloaded_weights(self) -> None:
        """Ultralytics downloads a bare weight name into the process CWD; move it into
        the shared cache so the next job starts from disk."""
        pending = getattr(self, "_pending_cache", None)
        if not pending:
            return
        self._pending_cache = None
        name, target = pending
        for candidate in (os.path.abspath(name), os.path.join(os.getcwd(), name)):
            if os.path.isfile(candidate) and not os.path.exists(target):
                try:
                    shutil.move(candidate, target)
                    log.info("cached pretrained weights", weights=target)
                except OSError as e:  # noqa: PERF203
                    log.warn("could not cache weights", error=str(e)[:120])
                return

    def _flush_log_artifact(self, job_id: str, job_execution_id: str, log_path: str) -> None:
        """Best-effort: push the log-so-far to a fixed MinIO key (overwritten every
        call, not a new object each time) so the UI can show accumulated output while
        RUNNING, not just the latest progress_message line. The artifacts row for this
        key is inserted once (first flush of this run) and never updated afterwards —
        trg_artifacts_content_immutable forbids UPDATEs on content columns, but the
        MinIO object behind a fixed key can still be overwritten freely; only the row's
        checksum column goes stale, and nothing reads it back for verification."""
        if not os.path.isfile(log_path):
            return
        try:
            key = f"artifacts/training-job/{job_id}/live/training.log"
            up = self.storage.put_file(key, log_path, "text/plain")
        except Exception as e:  # noqa: BLE001
            log.warn("live log upload failed", training_job_id=job_id, error=str(e)[:200])
            return
        if getattr(self, "_live_log_artifact_id", None):
            return
        try:
            with psycopg.connect(self.cfg.pg_conninfo(), autocommit=True) as conn:
                with conn.cursor() as cur:
                    # Re-runs of the same job keep the fixed live key from the previous
                    # run's artifacts row — the content is immutable (row can't be
                    # updated) but the MinIO object behind it can. Reuse that row
                    # instead of blind-inserting and tripping uq_artifacts_object.
                    cur.execute(
                        "SELECT id FROM artifacts WHERE bucket_name=%s AND object_key=%s",
                        (up["bucket"], up["object_key"]),
                    )
                    row = cur.fetchone()
                    if row:
                        artifact_id = row[0]
                    else:
                        artifact_id = str(uuid.uuid4())
                        cur.execute(
                            "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, "
                            "source_execution_id, status, bucket_name, object_key, filename, mime_type, "
                            "file_size_bytes, checksum, is_primary, created_by_actor_type, created_by_actor_ref) "
                            "VALUES (%s,'TRAINING_JOB',%s,'TRAIN_LOG',%s,'VERIFIED',%s,%s,'training.log',"
                            "'text/plain',%s,%s,false,'WORKER',%s)",
                            (artifact_id, job_id, job_execution_id, up["bucket"], up["object_key"],
                             up["size"], up["checksum"], self.cfg.consumer),
                        )
            self._live_log_artifact_id = artifact_id
        except Exception as e:  # noqa: BLE001
            log.warn("live log artifact insert failed", training_job_id=job_id, error=str(e)[:200])

    def _progress(self, job_execution_id: str, pct: float, message: str) -> None:
        """Best-effort live progress update on job_executions, mirrors dataset-worker's
        joblog.progress(). Own autocommit connection so it's visible immediately;
        failures are swallowed — progress is a nicety, never a task-killer."""
        try:
            with psycopg.connect(self.cfg.pg_conninfo(), autocommit=True) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE job_executions SET progress_percent=%s, progress_message=%s, "
                        "heartbeat_at=now() WHERE id=%s AND status='RUNNING'",
                        (min(max(round(pct), 0), 100), message[:200], job_execution_id),
                    )
        except Exception as e:  # noqa: BLE001
            log.warn("progress update failed", job_execution_id=job_execution_id, error=str(e)[:200])

    def _train(self, ctx: dict, work_dir: str, job_id: str, job_execution_id: str) -> str:
        self._stopped_by_request = False
        self._live_log_artifact_id = None
        if not os.path.isfile(ctx["data_yaml"]):
            raise TrainingError("PREPARATION", "TRAINING_DATA_YAML_MISSING", f"data.yaml not found: {ctx['data_yaml']}")
        shutil.rmtree(work_dir, ignore_errors=True)
        os.makedirs(work_dir, exist_ok=True)

        hp = ctx["hp"]
        epochs = int(hp.get("epochs", 100))
        imgsz = int(hp.get("imgsz", 640))
        batch = int(hp.get("batch", 16))
        extra = self._train_overrides(hp)

        try:
            from ultralytics import YOLO
        except Exception as e:  # noqa: BLE001
            raise TrainingError("PREPARATION", "TRAINING_RUNTIME_UNAVAILABLE", f"ultralytics import failed: {e}")

        base_pt = ctx.get("base_pt")
        if base_pt and not os.path.isfile(base_pt):
            try:
                bucket, obj_key, checksum = ctx.get("base_artifact") or (None, None, None)
                base_pt = fetch_model_file(self.storage, work_dir, ctx["base_model_id"],
                                           base_pt, bucket, obj_key, checksum)
            except (FileNotFoundError, RuntimeError) as e:
                raise TrainingError("PREPARATION", "TRAINING_BASE_MODEL_MISSING", str(e)[:500]) from e
        if base_pt and not os.path.isfile(base_pt):
            raise TrainingError("PREPARATION", "TRAINING_BASE_MODEL_MISSING", f"base model not found: {base_pt}")

        weights = base_pt or self._resolve_base_weights(ctx)
        if not base_pt:
            weights = self._cached_official_weights(weights)
        log.info("starting ultralytics training", training_job_id=job_id, epochs=epochs, imgsz=imgsz,
                 device=self.cfg.device, base_model=weights,
                 overrides=sorted(extra) or None)
        try:
            model = YOLO(weights)
        except Exception as e:  # noqa: BLE001
            # Ultralytics reports a download failure as a generic exception; make the
            # cause actionable rather than leaving "Environment may be offline".
            if "Download failure" in str(e) or "offline" in str(e).lower():
                raise TrainingError(
                    "PREPARATION", "TRAINING_WEIGHTS_DOWNLOAD_FAILED",
                    f"could not obtain pretrained weights {os.path.basename(str(weights))}: the worker "
                    f"has no route to the Ultralytics release host. Give the training worker egress, or "
                    f"pre-seed {self._weights_cache_dir()} with the weight file.",
                )
            raise
        self._file_downloaded_weights()

        def _stop_check(trainer):
            try:
                with psycopg.connect(self.cfg.pg_conninfo()) as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT status FROM training_jobs WHERE id=%s", (job_id,))
                        row = cur.fetchone()
                if row and row[0] == "STOPPING":
                    trainer.stop = True
                    self._stopped_by_request = True
            except Exception as e:  # noqa: BLE001
                log.warn("stop-check failed", training_job_id=job_id, error=str(e)[:200])
        model.add_callback("on_train_epoch_end", _stop_check)

        log_path = os.path.join(work_dir, "training.log")

        def _progress_flush(trainer):
            done = trainer.epoch + 1
            total = trainer.epochs
            pct = (done / total) * 100 if total else 0
            loss_bits = ""
            if getattr(trainer, "tloss", None) is not None:
                try:
                    loss_bits = " (" + ", ".join(f"{k}={v:.4f}" for k, v in trainer.tloss.items()) + ")"
                except Exception:  # noqa: BLE001
                    loss_bits = ""
            self._progress(job_execution_id, pct, f"epoch {done}/{total}{loss_bits}")
            self._flush_log_artifact(job_id, job_execution_id, log_path)
        model.add_callback("on_train_epoch_end", _progress_flush)

        # Tee ultralytics' stdout/stderr to disk as it's produced (not just after
        # train() returns) so _progress_flush can ship a growing log to MinIO for
        # live viewing, in addition to the final full-content upload below.
        log_buf = _TeeToFile(log_path)
        with contextlib.redirect_stdout(log_buf), contextlib.redirect_stderr(log_buf):
            # Built as a dict, not duplicate keyword arguments: `**extra` alongside an
            # explicit device= would raise "multiple values for keyword argument".
            # Order matters — overridable defaults first, then the user's values, then
            # the platform-owned arguments, which therefore always win.
            train_args = {
                "device": self.cfg.device, "verbose": True, "plots": True, "val": True,
                **extra,
                "data": ctx["data_yaml"], "epochs": epochs, "imgsz": imgsz, "batch": batch,
                "project": work_dir, "name": "run", "exist_ok": True,
            }
            model.train(**train_args)
        log_buf.close()
        if getattr(self, "_stopped_by_request", False):
            raise TrainingStopped()
        run_dir = os.path.join(work_dir, "run", "weights")
        best_pt = os.path.join(run_dir, "best.pt")
        last_pt = os.path.join(run_dir, "last.pt")
        if not os.path.isfile(best_pt):
            raise TrainingError("TRAINING", "TRAINING_NO_BEST_MODEL", "best.pt not produced by training")
        if os.path.isfile(last_pt):
            os.remove(last_pt)
        return best_pt

    def _store_and_register(self, ctx, job_id, job_execution_id, correlation_id, best_pt, run_base_dir) -> dict:
        checksum = _sha256(best_pt)
        size = os.path.getsize(best_pt)

        # 1) MinIO artifact (best.pt dual-store, part 1).
        best_artifact_id = str(uuid.uuid4())
        key = f"artifacts/training-job/{job_id}/{best_artifact_id}/best.pt"
        try:
            up = self.storage.put_file(key, best_pt, "application/octet-stream")
        except Exception as e:  # noqa: BLE001
            raise TrainingError(
                "POST_PROCESSING", "STORAGE_TEMPORARY_FAILURE",
                f"artifact upload failed: {str(e)[:300]}",
            )

        # 2) Model Root copy (best.pt dual-store, part 2) via staging + atomic rename.
        rel = f"registry/trained/{_sanitize(ctx['name'])}_{checksum[:6]}.pt"
        target_final = os.path.join(ctx["model_root_host"], rel)
        if os.path.exists(target_final):
            rel = f"registry/trained/{_sanitize(ctx['name'])}_{checksum[:6]}_{uuid.uuid4().hex[:6]}.pt"
            target_final = os.path.join(ctx["model_root_host"], rel)
        os.makedirs(os.path.dirname(target_final), exist_ok=True)
        staging = target_final + f".staging-{uuid.uuid4().hex[:8]}"
        shutil.copy2(best_pt, staging)
        if _sha256(staging) != checksum:
            os.remove(staging)
            raise TrainingError("MODEL_STORAGE", "MODEL_CHECKSUM_MISMATCH", "model root copy checksum mismatch")
        os.rename(staging, target_final)

        # 3) Upload every file the training run produced. Named plots map to their chart
        #    type; anything else (labels.jpg, train_batch*.jpg, args.yaml, future files)
        #    is kept as TRAINING_OUTPUT so no output is ever dropped from the artifacts list.
        chart_artifacts = []
        if run_base_dir and os.path.isdir(run_base_dir):
            chart_artifacts = upload_run_outputs(self.storage, run_base_dir, "training-job", job_id)
            log.info("training outputs uploaded", training_job_id=job_id, count=len(chart_artifacts))

        log_artifact = None
        log_path = os.path.join(os.path.dirname(run_base_dir), "training.log")
        if os.path.isfile(log_path):
            log_id = str(uuid.uuid4())
            log_key = f"artifacts/training-job/{job_id}/{log_id}/training.log"
            try:
                log_info = self.storage.put_file(log_key, log_path, "text/plain")
                log_artifact = {
                    "id": log_id, "bucket": log_info["bucket"],
                    "object_key": log_info["object_key"], "size": log_info["size"],
                    "checksum": log_info["checksum"],
                }
            except Exception:  # noqa: BLE001
                log.warn("log upload skipped", training_job_id=job_id)

        # Read the metadata back out of the checkpoint we just produced, using the same
        # extractor as the Model Root scan, so a trained model and a discovered one carry
        # identical fields (yolo_version, yolo_size, the imgsz it was trained at, ...).
        from .model_scan import read_checkpoint_metadata
        arch = read_checkpoint_metadata(best_pt)
        if "error" in arch:
            log.warn("could not read produced checkpoint metadata", error=arch["error"])
            arch = {"framework": "pytorch", "model_family": "ultralytics", "task": ctx["task_type"].lower()}
        try:
            import ultralytics
            arch.setdefault("ultralytics_version", ultralytics.__version__)
        except Exception:  # noqa: BLE001
            pass

        return {
            "checksum": checksum, "size": size, "relative_path": rel,
            "model_root_path": target_final,
            "best_artifact_id": best_artifact_id, "artifact": up, "architecture": arch,
            "chart_artifacts": chart_artifacts, "log_artifact": log_artifact,
        }

    def _complete(self, ctx, job_id, job_execution_id, correlation_id, result) -> None:
        model_id = str(uuid.uuid4())
        model_full_path = os.path.join(ctx["model_root_host"], result["relative_path"])
        with self.conn.cursor() as cur:
            # best.pt MinIO artifact record
            cur.execute(
                "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                "created_by_actor_type, created_by_actor_ref, verified_at) "
                "VALUES (%s,'TRAINING_JOB',%s,'BEST_MODEL',%s,'VERIFIED',%s,%s,'best.pt','application/octet-stream',%s,%s,true,'WORKER',%s,now())",
                (result["best_artifact_id"], job_id, job_execution_id, result["artifact"]["bucket"],
                 result["artifact"]["object_key"], result["size"], result["checksum"], self.cfg.consumer),
            )
            # Training artifacts — each insert in its own savepoint so one failure
            # (e.g. an unknown type code) can't abort the whole completion transaction.
            for ca in (result.get("chart_artifacts") or []):
                try:
                    cur.execute("SAVEPOINT art")
                    cur.execute(
                        "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                        "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                        "created_by_actor_type, created_by_actor_ref, verified_at) "
                        "VALUES (%s,'TRAINING_JOB',%s,%s,%s,'VERIFIED',%s,%s,%s,%s,%s,%s,false,'WORKER',%s,now()) "
                        "ON CONFLICT DO NOTHING",
                        (ca["id"], job_id, ca["type_code"], job_execution_id,
                         ca["bucket"], ca["object_key"], ca["fname"], ca["mime"],
                         ca["size"], ca["checksum"], self.cfg.consumer),
                    )
                    cur.execute("RELEASE SAVEPOINT art")
                except Exception as e:  # noqa: BLE001
                    cur.execute("ROLLBACK TO SAVEPOINT art")
                    log.warn("artifact insert failed", training_job_id=job_id, file=ca["fname"], error=str(e)[:200])
            # TRAIN_LOG artifact
            if result.get("log_artifact"):
                la = result["log_artifact"]
                try:
                    cur.execute("SAVEPOINT art")
                    cur.execute(
                        "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                        "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                        "created_by_actor_type, created_by_actor_ref, verified_at) "
                        "VALUES (%s,'TRAINING_JOB',%s,'TRAIN_LOG',%s,'VERIFIED',%s,%s,'training.log','text/plain',%s,%s,false,'WORKER',%s,now())",
                        (la["id"], job_id, job_execution_id, la["bucket"], la["object_key"],
                         la["size"], la["checksum"], self.cfg.consumer),
                    )
                    cur.execute("RELEASE SAVEPOINT art")
                except Exception as e:  # noqa: BLE001
                    cur.execute("ROLLBACK TO SAVEPOINT art")
                    log.warn("log artifact insert failed", training_job_id=job_id, error=str(e)[:200])
            # register TRAINING-source model
            cur.execute(
                "INSERT INTO models (id, name, dataset_type_id, task_type, source_type, status, "
                "relative_path, model_path, original_filename, file_size_bytes, checksum_algorithm, checksum, "
                "source_artifact_id, source_training_job_id, architecture_metadata, validation_summary, "
                "available_at, created_by_user_id) "
                "VALUES (%s,%s,%s,%s,'TRAINING','AVAILABLE',%s,%s,'best.pt',%s,'SHA-256',%s,%s,%s,%s,%s,now(),%s)",
                (model_id, ctx["name"], ctx["dataset_type_id"], ctx["task_type"],
                 result["relative_path"], model_full_path, result["size"], result["checksum"],
                 result["best_artifact_id"], job_id,
                 json.dumps(result["architecture"]), json.dumps({"trained": True}), ctx["created_by"]),
            )
            # RUNNING -> COMPLETED (+ result_model_id)
            cur.execute(
                "UPDATE training_jobs SET status='COMPLETED', finished_at=now(), result_model_id=%s, "
                "row_version=row_version+1, updated_at=now() WHERE id=%s AND status='RUNNING' RETURNING id",
                (model_id, job_id),
            )
            if cur.fetchone() is None:
                raise TrainingError("POST_PROCESSING", "TRAINING_STATE_LOST", "job left RUNNING before completion")
            cur.execute("UPDATE job_executions SET status='SUCCEEDED', finished_at=now(), progress_percent=100 WHERE id=%s", (job_execution_id,))
            self._audit_cur(cur, job_id, correlation_id, "TRAINING_JOB_COMPLETED", "SUCCESS",
                            {"from": "RUNNING", "to": "COMPLETED", "result_model_id": model_id})
            aid = self._audit_cur(cur, model_id, correlation_id, "MODEL_CREATED", "SUCCESS",
                                   {"source_type": "TRAINING", "training_job_id": job_id, "checksum": result["checksum"]},
                                   resource_type="MODEL")
            if ctx["created_by"]:
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'SUCCESS','Training Completed',%s,'TRAINING_JOB',%s)",
                    (aid, ctx["created_by"], f"Training \"{ctx['name']}\" completed; model registered.", job_id),
                )
        self.conn.commit()
        log.info("training completed", training_job_id=job_id, model_id=model_id, checksum=result["checksum"][:12])

    def _fail(self, ctx, job_id, job_execution_id, correlation_id, stage, code, message) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE training_jobs SET status='FAILED', finished_at=now(), failure_stage=%s, failure_code=%s, "
                "failure_message=%s, row_version=row_version+1, updated_at=now() "
                "WHERE id=%s AND status NOT IN ('COMPLETED','CANCELLED','STOPPED') RETURNING id",
                (stage, code, message[:1000], job_id),
            )
            cur.execute("UPDATE job_executions SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                        (code, message[:1000], job_execution_id))
            aid = self._audit_cur(cur, job_id, correlation_id, "TRAINING_JOB_FAILED", "FAILURE",
                                   {"failure_stage": stage}, error_code=code, error_message=message[:1000])
            if ctx and ctx.get("created_by"):
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'ERROR','Training Failed',%s,'TRAINING_JOB',%s)",
                    (aid, ctx["created_by"], f"Training \"{ctx.get('name','?')}\" failed: {code}.", job_id),
                )
        self.conn.commit()
        log.error("training failed", training_job_id=job_id, stage=stage, error_code=code, detail=message[:200])

    def _stopped(self, ctx, job_id, job_execution_id, correlation_id) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE training_jobs SET status='STOPPED', finished_at=now(), stopped_at=now(), "
                "row_version=row_version+1, updated_at=now() "
                "WHERE id=%s AND status='STOPPING' RETURNING id",
                (job_id,),
            )
            if cur.fetchone():
                cur.execute("UPDATE job_executions SET status='STOPPED', finished_at=now() WHERE id=%s", (job_execution_id,))
                aid = self._audit_cur(cur, job_id, correlation_id, "TRAINING_JOB_STOPPED", "SUCCESS",
                                       {"from": "STOPPING", "to": "STOPPED"})
                if ctx and ctx.get("created_by"):
                    cur.execute(
                        "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                        "resource_type_code, resource_id) VALUES (%s,%s,'WARNING','Training Stopped',%s,'TRAINING_JOB',%s)",
                        (aid, ctx["created_by"], f"Training \"{ctx.get('name', '?')}\" stopped by user request.", job_id),
                    )
        self.conn.commit()
        log.info("training stopped", training_job_id=job_id)

    def _audit(self, resource_id, correlation_id, action, result, metadata) -> None:
        with self.conn.cursor() as cur:
            self._audit_cur(cur, resource_id, correlation_id, action, result, metadata)
        self.conn.commit()

    def _audit_cur(self, cur, resource_id, correlation_id, action, result, metadata,
                   resource_type="TRAINING_JOB", error_code=None, error_message=None) -> int:
        cur.execute(
            "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
            "result, correlation_id, metadata, error_code, error_message) "
            "VALUES ('WORKER',%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (self.cfg.consumer, action, resource_type, resource_id, result, correlation_id,
             json.dumps(metadata), error_code, error_message),
        )
        return cur.fetchone()[0]
