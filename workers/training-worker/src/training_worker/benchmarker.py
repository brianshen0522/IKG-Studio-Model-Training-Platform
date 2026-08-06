"""Benchmark evaluation (doc 09): run one registered model against one dataset's
evaluation split via real Ultralytics `YOLO.val` (never train split, never mock metrics).
Each evaluation is an independent job; the last one to finish finalises the run status.
"""
import contextlib
import io
import json
import os
import shutil
import uuid

import psycopg

from . import log
from .heartbeat import Heartbeat
from .model_cache import fetch_model_file
from .run_outputs import upload_run_outputs


class BenchmarkStopped(Exception):
    pass


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _safe_idx(arr, i) -> float:
    if arr is not None and i < len(arr):
        try:
            return float(arr[i])
        except (TypeError, ValueError, IndexError):
            return 0.0
    return 0.0


class BenchmarkError(Exception):
    def __init__(self, stage: str, code: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message


class Benchmarker:
    def __init__(self, conn, storage, cfg) -> None:
        self.conn = conn
        self.storage = storage
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        eval_id = payload["benchmark_evaluation_id"]
        run_id = payload["benchmark_run_id"]
        job_execution_id = payload["job_execution_id"]
        assignment_token = payload["assignment_token"]
        correlation_id = payload.get("correlation_id")
        log.info("benchmark dispatched", benchmark_evaluation_id=eval_id, job_execution_id=job_execution_id)

        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE job_executions SET status='CLAIMED', claimed_at=now() "
                "WHERE id=%s AND assignment_token=%s AND status='ASSIGNED' RETURNING id",
                (job_execution_id, assignment_token),
            )
            if cur.fetchone() is None:
                log.warn("benchmark execution not claimable", job_execution_id=job_execution_id)
                return
            cur.execute("UPDATE job_executions SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=%s", (job_execution_id,))
            cur.execute(
                "UPDATE benchmark_evaluations SET status='RUNNING', started_at=now() "
                "WHERE id=%s AND status='QUEUED' RETURNING id",
                (eval_id,),
            )
            if cur.fetchone() is None:
                cur.execute(
                    "UPDATE benchmark_evaluations SET status='STOPPED', finished_at=now(), stopped_at=now() "
                    "WHERE id=%s AND status='STOPPING' RETURNING id",
                    (eval_id,),
                )
                if cur.fetchone() is not None:
                    log.info("evaluation stopped before start", benchmark_evaluation_id=eval_id)
                    cur.execute("UPDATE job_executions SET status='STOPPED', finished_at=now() WHERE id=%s", (job_execution_id,))
                    self._finalize_run(cur, run_id, None, correlation_id)
                    self.conn.commit()
                    return
                log.warn("evaluation not QUEUED (already handled/cancelled)", benchmark_evaluation_id=eval_id)
                self.conn.rollback()
                cur.execute("UPDATE job_executions SET status='CANCELLED', finished_at=now() WHERE id=%s", (job_execution_id,))
                self.conn.commit()
                return
            cur.execute(
                "UPDATE benchmark_runs SET status='RUNNING', started_at=coalesce(started_at, now()), updated_at=now() "
                "WHERE id=%s AND status='QUEUED'",
                (run_id,),
            )
        self.conn.commit()

        ctx = self._load(eval_id)
        work_dir = os.path.join(ctx["model_root_host"], ".benchmark", eval_id)
        try:
            with Heartbeat(self.cfg.pg_conninfo(), job_execution_id, self.cfg.heartbeat_interval_s):
                metrics = self._evaluate(ctx, work_dir, eval_id)
            self._complete(ctx, eval_id, run_id, job_execution_id, correlation_id, metrics)
        except BenchmarkStopped:
            self._stopped(eval_id, run_id, job_execution_id, correlation_id)
        except BenchmarkError as be:
            self._fail(eval_id, run_id, job_execution_id, correlation_id, be.code, be.message)
        except Exception as e:  # noqa: BLE001
            import traceback
            log.error("benchmark failure traceback", benchmark_evaluation_id=eval_id, detail=traceback.format_exc()[-2000:])
            self._fail(eval_id, run_id, job_execution_id, correlation_id, "BENCHMARK_FAILED", str(e)[:500])
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def _load(self, eval_id: str) -> dict:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT be.model_id, be.training_dataset_id, br.created_by_user_id, br.device, "
                "m.relative_path, m.model_path, "
                "a.bucket_name, a.object_key, a.checksum, "
                "d.relative_path, dt.model_path, dt.training_dataset_path "
                "FROM benchmark_evaluations be "
                "JOIN benchmark_runs br ON br.id = be.benchmark_run_id "
                "JOIN models m ON m.id = be.model_id "
                "JOIN training_datasets d ON d.id = be.training_dataset_id "
                "JOIN dataset_types dt ON dt.id = d.dataset_type_id "
                "LEFT JOIN artifacts a ON a.id = m.source_artifact_id AND a.artifact_type_code='BEST_MODEL' "
                "WHERE be.id=%s",
                (eval_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise BenchmarkError("VALIDATION", "BENCHMARK_EVALUATION_NOT_FOUND", "evaluation not found")
            (model_id, ds_id, created_by, device, m_rel, m_model_path,
             model_bucket, model_key, model_checksum, ds_rel,
             model_root_host, training_dataset_path) = row
            if not model_root_host:
                raise BenchmarkError("VALIDATION", "MODEL_ROOT_NOT_FOUND", "dataset type has no model_path configured")
            # Datasets resolve under training_dataset_path; only model files use model_path.
            if not training_dataset_path:
                raise BenchmarkError("VALIDATION", "TD_PATH_NOT_SET", "dataset type has no training_dataset_path configured")
        return {
            "model_id": str(model_id), "training_dataset_id": str(ds_id), "created_by": created_by,
            "device": (device or "").strip(),
            "model_pt": m_model_path or os.path.join(model_root_host, m_rel),
            "model_artifact": (model_bucket, model_key, model_checksum),
            "data_yaml": os.path.join(training_dataset_path, ds_rel, "data.yaml"),
            "model_root_host": model_root_host,
        }

    def _evaluate(self, ctx: dict, work_dir: str, eval_id: str) -> dict:
        if not os.path.isfile(ctx["data_yaml"]):
            raise BenchmarkError("PREPARATION", "BENCHMARK_DATA_YAML_MISSING", f"data.yaml not found: {ctx['data_yaml']}")
        shutil.rmtree(work_dir, ignore_errors=True)
        os.makedirs(work_dir, exist_ok=True)

        if not os.path.isfile(ctx["model_pt"]):
            try:
                bucket, obj_key, checksum = ctx.get("model_artifact") or (None, None, None)
                ctx["model_pt"] = fetch_model_file(self.storage, work_dir, ctx["model_id"],
                                                   ctx["model_pt"], bucket, obj_key, checksum)
            except (FileNotFoundError, RuntimeError) as e:
                raise BenchmarkError("PREPARATION", "BENCHMARK_MODEL_MISSING", str(e)[:500]) from e
        if not os.path.isfile(ctx["model_pt"]):
            raise BenchmarkError("PREPARATION", "BENCHMARK_MODEL_MISSING", f"model not found: {ctx['model_pt']}")

        try:
            from ultralytics import YOLO
        except Exception as e:  # noqa: BLE001
            raise BenchmarkError("PREPARATION", "BENCHMARK_RUNTIME_UNAVAILABLE", f"ultralytics import failed: {e}")

        device = ctx.get("device") or self.cfg.device
        log.info("starting ultralytics val", benchmark_evaluation_id=eval_id, device=device)
        model = YOLO(ctx["model_pt"])

        def _stop_check(validator):
            try:
                with psycopg.connect(self.cfg.pg_conninfo()) as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT status FROM benchmark_evaluations WHERE id=%s", (eval_id,))
                        row = cur.fetchone()
                if row and row[0] == "STOPPING":
                    raise BenchmarkStopped()
            except BenchmarkStopped:
                raise
            except Exception as e:  # noqa: BLE001
                log.warn("stop-check failed", benchmark_evaluation_id=eval_id, error=str(e)[:200])
        model.add_callback("on_val_batch_end", _stop_check)

        log_buf = io.StringIO()
        with contextlib.redirect_stdout(log_buf), contextlib.redirect_stderr(log_buf):
            results = model.val(
                data=ctx["data_yaml"], split="val", device=device,
                project=work_dir, name="val", exist_ok=True, verbose=True, plots=True,
            )
        log_path = os.path.join(work_dir, "benchmark.log")
        with open(log_path, "w") as f:
            f.write(log_buf.getvalue())
        box = results.box
        p = _f(getattr(box, "mp", 0.0))
        r = _f(getattr(box, "mr", 0.0))
        f1 = (2 * p * r / (p + r)) if (p + r) > 0 else 0.0
        maps = getattr(box, "maps", None)
        maps_list = [_f(x) for x in maps] if maps is not None else []
        names = getattr(results, "names", {}) or {}
        idxs = getattr(box, "ap_class_index", None)
        per_class = []
        if idxs is not None:
            for i, cls in enumerate(list(idxs)):
                per_class.append({
                    "class_index": int(cls),
                    "class_name": names.get(int(cls), str(int(cls))) if isinstance(names, dict) else str(int(cls)),
                    "precision": _f(_safe_idx(getattr(box, "p", None), i)),
                    "recall": _f(_safe_idx(getattr(box, "r", None), i)),
                    "map50": _f(_safe_idx(getattr(box, "ap50", None), i)),
                    "map50_95": _f(_safe_idx(getattr(box, "ap", None), i)),
                })
        return {
            "map50": _f(getattr(box, "map50", 0.0)),
            "map50_95": _f(getattr(box, "map", 0.0)),
            "precision": p, "recall": r, "f1": f1,
            "detail": {
                "split": "val",
                "maps_per_class": maps_list,
                "per_class": per_class,
                "ultralytics_results_dir": os.path.join(work_dir, "val"),
            },
        }

    def _complete(self, ctx, eval_id, run_id, job_execution_id, correlation_id, metrics) -> None:
        artifact_id = str(uuid.uuid4())
        data = json.dumps(metrics, ensure_ascii=False).encode("utf-8")
        key = f"artifacts/benchmark-evaluation/{eval_id}/{artifact_id}/metrics.json"
        info = self.storage.put_bytes(key, data, "application/json") if hasattr(self.storage, "put_bytes") else None
        if info is None:
            tmp = f"/tmp/metrics-{eval_id}.json"
            with open(tmp, "wb") as f:
                f.write(data)
            info = self.storage.put_file(key, tmp, "application/json")
            os.remove(tmp)

        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                "created_by_actor_type, created_by_actor_ref, verified_at) "
                "VALUES (%s,'BENCHMARK_EVALUATION',%s,'BENCHMARK_METRICS',%s,'VERIFIED',%s,%s,'metrics.json','application/json',%s,%s,true,'WORKER',%s,now())",
                (artifact_id, eval_id, job_execution_id, info["bucket"], info["object_key"], info["size"], info["checksum"], self.cfg.consumer),
            )
            log_path = os.path.join(ctx.get("model_root_host", "/tmp"), ".benchmark", eval_id, "benchmark.log")
            if os.path.isfile(log_path):
                log_id = str(uuid.uuid4())
                log_key = f"artifacts/benchmark-evaluation/{eval_id}/{log_id}/benchmark.log"
                try:
                    log_info = self.storage.put_file(log_key, log_path, "text/plain")
                    cur.execute("SAVEPOINT art")
                    cur.execute(
                        "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                        "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                        "created_by_actor_type, created_by_actor_ref, verified_at) "
                        "VALUES (%s,'BENCHMARK_EVALUATION',%s,'TRAIN_LOG',%s,'VERIFIED',%s,%s,'benchmark.log','text/plain',%s,%s,false,'WORKER',%s,now())",
                        (log_id, eval_id, job_execution_id, log_info["bucket"], log_info["object_key"],
                         log_info["size"], log_info["checksum"], self.cfg.consumer),
                    )
                    cur.execute("RELEASE SAVEPOINT art")
                except Exception as e:  # noqa: BLE001
                    cur.execute("ROLLBACK TO SAVEPOINT art")
                    log.warn("benchmark log upload failed", benchmark_evaluation_id=eval_id, error=str(e)[:200])
            val_dir = metrics["detail"].get("ultralytics_results_dir")
            if val_dir and os.path.isdir(val_dir):
                for pa in upload_run_outputs(self.storage, val_dir, "benchmark-evaluation", eval_id):
                    try:
                        cur.execute("SAVEPOINT art")
                        cur.execute(
                            "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                            "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                            "created_by_actor_type, created_by_actor_ref, verified_at) "
                            "VALUES (%s,'BENCHMARK_EVALUATION',%s,%s,%s,'VERIFIED',%s,%s,%s,%s,%s,%s,false,'WORKER',%s,now())",
                            (pa["id"], eval_id, pa["type_code"], job_execution_id, pa["bucket"], pa["object_key"],
                             pa["fname"], pa["mime"], pa["size"], pa["checksum"], self.cfg.consumer),
                        )
                        cur.execute("RELEASE SAVEPOINT art")
                    except Exception as e:  # noqa: BLE001
                        cur.execute("ROLLBACK TO SAVEPOINT art")
                        log.warn("benchmark plot artifact upload failed", benchmark_evaluation_id=eval_id, filename=pa["fname"], error=str(e)[:200])
            cur.execute(
                "UPDATE benchmark_evaluations SET status='COMPLETED', finished_at=now(), "
                "map50=%s, map50_95=%s, precision=%s, recall=%s, f1=%s, metrics=%s "
                "WHERE id=%s AND status='RUNNING' RETURNING id",
                (metrics["map50"], metrics["map50_95"], metrics["precision"], metrics["recall"], metrics["f1"],
                 json.dumps(metrics), eval_id),
            )
            if cur.fetchone() is None:
                raise BenchmarkError("POST_PROCESSING", "BENCHMARK_STATE_LOST", "evaluation left RUNNING before completion")
            cur.execute("UPDATE job_executions SET status='SUCCEEDED', finished_at=now(), progress_percent=100 WHERE id=%s", (job_execution_id,))
            self._audit(cur, eval_id, correlation_id, "BENCHMARK_EVALUATION_COMPLETED", "SUCCESS",
                        {"map50": metrics["map50"], "map50_95": metrics["map50_95"]})
            self._finalize_run(cur, run_id, ctx.get("created_by"), correlation_id)
        self.conn.commit()
        log.info("benchmark evaluation completed", benchmark_evaluation_id=eval_id,
                 map50=round(metrics["map50"], 4), map50_95=round(metrics["map50_95"], 4))

    def _stopped(self, eval_id, run_id, job_execution_id, correlation_id) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE benchmark_evaluations SET status='STOPPED', finished_at=now(), stopped_at=now() "
                "WHERE id=%s AND status='STOPPING' RETURNING id",
                (eval_id,),
            )
            if cur.fetchone() is not None:
                cur.execute("UPDATE job_executions SET status='STOPPED', finished_at=now() WHERE id=%s", (job_execution_id,))
                self._audit(cur, eval_id, correlation_id, "BENCHMARK_EVALUATION_STOPPED", "SUCCESS",
                            {"from": "STOPPING", "to": "STOPPED"})
            self._finalize_run(cur, run_id, None, correlation_id)
        self.conn.commit()
        log.info("benchmark evaluation stopped", benchmark_evaluation_id=eval_id)

    def _fail(self, eval_id, run_id, job_execution_id, correlation_id, code, message) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE benchmark_evaluations SET status='FAILED', finished_at=now(), failure_code=%s, failure_message=%s "
                "WHERE id=%s AND status NOT IN ('COMPLETED','CANCELLED') RETURNING id",
                (code, message[:1000], eval_id),
            )
            cur.execute("UPDATE job_executions SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                        (code, message[:1000], job_execution_id))
            self._audit(cur, eval_id, correlation_id, "BENCHMARK_EVALUATION_FAILED", "FAILURE",
                        {"failure_code": code}, error_code=code, error_message=message[:1000])
            self._finalize_run(cur, run_id, None, correlation_id)
        self.conn.commit()
        log.error("benchmark evaluation failed", benchmark_evaluation_id=eval_id, error_code=code, detail=message[:200])

    def _finalize_run(self, cur, run_id, created_by, correlation_id) -> None:
        cur.execute(
            "SELECT count(*) FILTER (WHERE status='COMPLETED'), count(*) FILTER (WHERE status='FAILED'), "
            "count(*) FILTER (WHERE status='STOPPED'), "
            "count(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED','STOPPED')), count(*) "
            "FROM benchmark_evaluations WHERE benchmark_run_id=%s",
            (run_id,),
        )
        completed, failed, stopped, pending, total = cur.fetchone()
        cur.execute("UPDATE benchmark_runs SET completed_count=%s, failed_count=%s, updated_at=now() WHERE id=%s",
                    (completed, failed, run_id))
        if pending == 0 and total > 0:
            if stopped > 0:
                status = "STOPPED"
            else:
                status = "COMPLETED" if failed == 0 else ("PARTIALLY_FAILED" if completed > 0 else "FAILED")
            cur.execute(
                "UPDATE benchmark_runs SET status=%s, finished_at=now(), stopped_at=(CASE WHEN %s='STOPPED' THEN now() ELSE stopped_at END), updated_at=now() "
                "WHERE id=%s AND status IN ('RUNNING','STOPPING') RETURNING id",
                (status, status, run_id),
            )
            if cur.fetchone() is not None:
                aid = self._audit(cur, run_id, correlation_id, "BENCHMARK_RUN_FINISHED",
                                   "SUCCESS" if status in ("COMPLETED", "STOPPED") else "FAILURE",
                                   {"status": status, "completed": completed, "failed": failed},
                                   resource_type="BENCHMARK_RUN")
                if created_by:
                    sev = "SUCCESS" if status == "COMPLETED" else ("WARNING" if status in ("PARTIALLY_FAILED", "STOPPED") else "ERROR")
                    cur.execute(
                        "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                        "resource_type_code, resource_id) VALUES (%s,%s,%s,'Benchmark Finished',%s,'BENCHMARK_RUN',%s)",
                        (aid, created_by, sev, f"Benchmark finished: {status} ({completed} ok, {failed} failed).", run_id),
                    )

    def _audit(self, cur, resource_id, correlation_id, action, result, metadata,
               resource_type="BENCHMARK_EVALUATION", error_code=None, error_message=None) -> int:
        cur.execute(
            "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
            "result, correlation_id, metadata, error_code, error_message) "
            "VALUES ('WORKER',%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (self.cfg.consumer, action, resource_type, resource_id, result, correlation_id,
             json.dumps(metadata), error_code, error_message),
        )
        return cur.fetchone()[0]
