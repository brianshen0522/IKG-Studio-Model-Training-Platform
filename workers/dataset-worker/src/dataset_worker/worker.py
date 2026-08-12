import json
import os
import time
import uuid
import hashlib

import psycopg
import redis as redislib

from . import joblog, log, scanner
from .builder import DatasetBuilder
from .model_ingest import ModelIngestWorker
from .reindexer import Reindexer
from .config import Config
from .storage import Storage

DISPATCH_EVENT = "job.dataset_scan.dispatch"
BUILD_EVENT = "job.dataset_build.dispatch"
TRAINING_DATASET_SCAN_EVENT = "job.training_dataset_scan.dispatch"
MODEL_INGEST_EVENT = "job.model_ingest.dispatch"
TRAINING_DATASET_DELETE_EVENT = "job.training_dataset_delete.dispatch"
DIRECTORY_REINDEX_EVENT = "job.dataset_directory_reindex.dispatch"


def _within_root(root: str, target: str) -> bool:
    root_r = os.path.realpath(root)
    target_r = os.path.realpath(target)
    return target_r == root_r or target_r.startswith(root_r + os.sep)


def _has_symlink_component(root: str, target: str) -> bool:
    """True if any path component from root down to target is a symlink."""
    root_r = os.path.realpath(root)
    cur = os.path.abspath(target)
    while cur != root_r and len(cur) > len(root_r):
        if os.path.islink(cur):
            return True
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return False


class DatasetWorker:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.redis = redislib.from_url(cfg.redis_url, decode_responses=True)
        self.storage = Storage(cfg)

    def setup(self) -> None:
        try:
            self.redis.xgroup_create(self.cfg.stream, self.cfg.group, id="0", mkstream=True)
        except redislib.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise
        self.storage.ensure_bucket()
        log.info("dataset-worker ready", stream=self.cfg.stream, group=self.cfg.group, consumer=self.cfg.consumer)

    def run(self) -> None:
        self.setup()
        while True:
            try:
                self._reclaim_orphaned()
            except (redislib.TimeoutError, redislib.ConnectionError) as e:
                log.warn("orphan reclaim skipped", error=str(e)[:200])
            try:
                resp = self.redis.xreadgroup(
                    self.cfg.group, self.cfg.consumer,
                    {self.cfg.stream: ">"}, count=1, block=self.cfg.block_ms,
                )
            except (redislib.TimeoutError, redislib.ConnectionError) as e:
                log.warn("redis read interrupted, retrying", error=str(e)[:200])
                continue
            if not resp:
                continue
            for _stream, messages in resp:
                for msg_id, fields in messages:
                    try:
                        self._handle(fields)
                    except Exception as e:  # noqa: BLE001
                        log.error("message handling failed", error=str(e)[:300], msg_id=msg_id)
                    finally:
                        self.redis.xack(self.cfg.stream, self.cfg.group, msg_id)

    def _reclaim_orphaned(self) -> None:
        start_id = "0-0"
        while True:
            start_id, messages, _deleted = self.redis.xautoclaim(
                self.cfg.stream, self.cfg.group, self.cfg.consumer,
                self.cfg.reclaim_idle_s * 1000, start_id,
            )
            if not messages:
                break
            for msg_id, fields in messages:
                try:
                    self._handle(fields)
                except Exception as e:  # noqa: BLE001
                    log.error("reclaimed message handling failed", error=str(e)[:300], msg_id=msg_id)
                finally:
                    self.redis.xack(self.cfg.stream, self.cfg.group, msg_id)

    def _handle(self, fields: dict) -> None:
        event_type = fields.get("event_type")
        if event_type == BUILD_EVENT:
            payload = json.loads(fields.get("payload", "{}"))
            with psycopg.connect(self.cfg.pg_conninfo()) as conn:
                DatasetBuilder(conn, self.storage, self.cfg).run(payload)
            return
        if event_type == MODEL_INGEST_EVENT:
            payload = json.loads(fields.get("payload", "{}"))
            with psycopg.connect(self.cfg.pg_conninfo()) as conn:
                ModelIngestWorker(conn, self.storage, self.cfg).run(payload)
            return
        if event_type == TRAINING_DATASET_SCAN_EVENT:
            payload = json.loads(fields.get("payload", "{}"))
            with psycopg.connect(self.cfg.pg_conninfo()) as conn:
                self._scan_training_dataset(conn, payload)
            return
        if event_type == TRAINING_DATASET_DELETE_EVENT:
            payload = json.loads(fields.get("payload", "{}"))
            from .training_dataset_delete import TrainingDatasetDeleter
            with psycopg.connect(self.cfg.pg_conninfo()) as conn:
                TrainingDatasetDeleter(conn, self.cfg).run(payload)
            return
        if event_type == DIRECTORY_REINDEX_EVENT:
            payload = json.loads(fields.get("payload", "{}"))
            with psycopg.connect(self.cfg.pg_conninfo()) as conn:
                Reindexer(conn, self.cfg).run(payload["dataset_type_id"], payload.get("correlation_id"))
            return
        if event_type != DISPATCH_EVENT:
            return
        payload = json.loads(fields.get("payload", "{}"))
        job_execution_id = payload["job_execution_id"]
        assignment_token = payload["assignment_token"]
        source_dataset_id = payload["source_dataset_id"]
        scan_id = payload["scan_id"]
        correlation_id = payload.get("correlation_id")
        log.info("dataset scan dispatched", job_execution_id=job_execution_id,
                 source_dataset_id=source_dataset_id, correlation_id=correlation_id)

        with psycopg.connect(self.cfg.pg_conninfo()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE job_executions SET status='CLAIMED', claimed_at=now() "
                    "WHERE id=%s AND assignment_token=%s AND status='ASSIGNED' RETURNING id",
                    (job_execution_id, assignment_token),
                )
                if cur.fetchone() is None:
                    log.warn("execution not claimable (already handled?)", job_execution_id=job_execution_id)
                    return
                cur.execute("UPDATE job_executions SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=%s", (job_execution_id,))
                cur.execute("UPDATE source_dataset_scans SET status='RUNNING', started_at=now() WHERE id=%s", (scan_id,))
                conn.commit()

                cur.execute(
                    "SELECT sd.name, sd.task_type, sd.relative_path, sd.images_relative_path, "
                    "sd.labels_relative_path, sd.classes_file_relative_path, sd.allow_subdirectories, "
                    "sd.created_by_user_id, sd.dataset_type_id, sd.manual_classes_override "
                    "FROM source_datasets sd WHERE sd.id=%s",
                    (source_dataset_id,),
                )
                row = cur.fetchone()

            with joblog.Capture(self.storage, self.cfg.pg_conninfo(), self.cfg.consumer, job_execution_id):
                try:
                    (name, task_type, relative_path, images_rel, labels_rel,
                     classes_rel, allow_subdirs, created_by, dataset_type_id, manual_override) = row
                    base = relative_path
                    images_dir = os.path.join(base, images_rel)
                    labels_dir = os.path.join(base, labels_rel)
                    classes_file = os.path.join(base, classes_rel) if classes_rel else None

                    root_check = base
                    for label, d in (("images", images_dir), ("labels", labels_dir)):
                        if not os.path.isdir(d):
                            raise ScanError("DATASET_PATH_NOT_FOUND", f"{label} path not found: {d}")
                        if not _within_root(root_check, d):
                            raise ScanError("DATASET_PATH_OUTSIDE_ROOT", f"{label} path outside root")
                        if _has_symlink_component(root_check, d) or os.path.islink(d):
                            raise ScanError("DATASET_PATH_SYMLINK_NOT_ALLOWED", f"{label} path traverses a symlink")

                    fallback_names = None
                    if not classes_file and not manual_override:
                        fallback_names = self._majority_classes_for_type(conn, dataset_type_id, source_dataset_id)

                    def on_progress(pct: float, msg: str) -> None:
                        log.info(msg, progress_percent=f"{pct:.0f}")
                        joblog.progress(self.cfg.pg_conninfo(), job_execution_id, pct, msg)

                    res = scanner.scan(images_dir, labels_dir, classes_file, task_type, bool(allow_subdirs),
                                        fallback_names, manual_override, on_progress)
                    self._complete(conn, source_dataset_id, scan_id, job_execution_id, correlation_id,
                                   name, created_by, res)
                except ScanError as se:
                    self._fail(conn, source_dataset_id, scan_id, job_execution_id, correlation_id, name, created_by, se.code, se.message)
                except Exception as e:  # noqa: BLE001
                    self._fail(conn, source_dataset_id, scan_id, job_execution_id, correlation_id,
                               row[0] if row else "?", row[7] if row else None, "DATASET_SCAN_FAILED", str(e)[:300])

    def _majority_classes_for_type(self, conn, dataset_type_id, exclude_source_dataset_id) -> list[str] | None:
        """Most-used classes.txt among other source datasets of the same type.

        Only considers each source dataset's *latest* scan and only those that came
        from an actual classes.txt (classes_source='CLASSES_FILE') — inferred /
        fallback class lists never count as votes, to avoid guesses reinforcing
        themselves. Ties broken by classes_hash value for determinism.
        """
        with conn.cursor() as cur:
            cur.execute(
                "SELECT sc.classes_hash, COUNT(*) AS n FROM source_datasets sd "
                "JOIN source_dataset_scans sc ON sc.id = sd.latest_scan_id "
                "WHERE sd.dataset_type_id=%s AND sd.id<>%s AND sd.archived_at IS NULL "
                "AND sc.classes_source='CLASSES_FILE' AND sc.classes_hash IS NOT NULL "
                "GROUP BY sc.classes_hash ORDER BY n DESC, sc.classes_hash ASC LIMIT 1",
                (dataset_type_id, exclude_source_dataset_id),
            )
            row = cur.fetchone()
            if row is None:
                return None
            classes_hash = row[0]
            cur.execute(
                "SELECT class_index, class_name FROM source_dataset_classes "
                "WHERE scan_id = (SELECT sc.id FROM source_datasets sd "
                "JOIN source_dataset_scans sc ON sc.id = sd.latest_scan_id "
                "WHERE sd.dataset_type_id=%s AND sc.classes_hash=%s LIMIT 1) "
                "ORDER BY class_index",
                (dataset_type_id, classes_hash),
            )
            rows = cur.fetchall()
            if not rows:
                return None
            return [r[1] for r in rows]

    def _upload_manifest(self, scan_id: str, res: scanner.ScanResult) -> dict:
        artifact_id = str(uuid.uuid4())
        manifest = {
            "scan_id": scan_id,
            "classes": res.classes,
            "summary": {
                "image_count": res.image_count, "label_count": res.label_count,
                "matched_pair_count": res.matched_pair_count,
                "missing_label_count": res.missing_label_count,
                "missing_image_count": res.missing_image_count,
                "invalid_label_count": res.invalid_label_count,
                "empty_label_count": res.empty_label_count,
                # Rows carrying the optional trailing confidence column; the build
                # strips it, so this is how many rows will be rewritten.
                "confidence_label_count": res.confidence_label_count,
                "ignored_file_count": res.ignored_file_count,
                "class_count": res.class_count,
                "content_hash": res.content_hash,
            },
            "items": res.items,
        }
        data = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        key = f"artifacts/source-dataset-scan/{scan_id}/{artifact_id}/manifest.json"
        info = self.storage.put_bytes(key, data, "application/json")
        info["artifact_id"] = artifact_id
        return info

    def _complete(self, conn, source_dataset_id, scan_id, job_execution_id, correlation_id, name, created_by, res):
        up = self._upload_manifest(scan_id, res)
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                "created_by_actor_type, created_by_actor_ref, verified_at) "
                "VALUES (%s,'SOURCE_DATASET_SCAN',%s,'DATASET_MANIFEST',%s,'VERIFIED',%s,%s,'manifest.json',"
                "'application/json',%s,%s,true,'WORKER',%s,now())",
                (up["artifact_id"], scan_id, job_execution_id, up["bucket"], up["object_key"],
                 up["size"], up["checksum"], self.cfg.consumer),
            )
            cur.execute(
                "UPDATE source_dataset_scans SET status='COMPLETED', finished_at=now(), "
                "image_count=%s, label_count=%s, matched_pair_count=%s, missing_image_count=%s, "
                "missing_label_count=%s, invalid_label_count=%s, empty_label_count=%s, ignored_file_count=%s, "
                "warning_count=%s, error_count=%s, class_count=%s, classes_hash=%s, classes_source=%s, content_hash=%s, "
                "manifest_artifact_id=%s, summary=%s WHERE id=%s",
                (res.image_count, res.label_count, res.matched_pair_count, res.missing_image_count,
                 res.missing_label_count, res.invalid_label_count, res.empty_label_count, res.ignored_file_count,
                 res.warning_count, res.error_count, res.class_count, res.classes_hash,
                 res.classes_source if res.classes else None, res.content_hash,
                 up["artifact_id"], json.dumps({"has_warnings": res.has_warnings, "status": res.status}), scan_id),
            )
            for c in res.classes:
                cur.execute(
                    "INSERT INTO source_dataset_classes (scan_id, class_index, class_name, source, object_count) "
                    "VALUES (%s,%s,%s,%s,%s)",
                    (scan_id, c["class_index"], c["class_name"], c["source"], c["object_count"]),
                )
            for iss in res.issues:
                cur.execute(
                    "INSERT INTO source_dataset_scan_issues (scan_id, severity, issue_code, image_relative_path, "
                    "label_relative_path, line_number, details) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (scan_id, iss["severity"], iss["issue_code"], iss["image_relative_path"],
                     iss["label_relative_path"], iss["line_number"], json.dumps(iss["details"])),
                )
            cur.execute("UPDATE source_datasets SET status=%s, updated_at=now() WHERE id=%s", (res.status, source_dataset_id))
            cur.execute(
                "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                "result, correlation_id, metadata) VALUES ('WORKER',%s,'SOURCE_DATASET_SCAN_COMPLETED',"
                "'SOURCE_DATASET_SCAN',%s,'SUCCESS',%s,%s) RETURNING id",
                (self.cfg.consumer, scan_id, correlation_id,
                 json.dumps({"image_count": res.image_count, "matched_pair_count": res.matched_pair_count,
                             "class_count": res.class_count, "status": res.status,
                             "warning_count": res.warning_count})),
            )
            audit_id = cur.fetchone()[0]
            if created_by:
                severity = "SUCCESS" if res.status == "READY" and not res.has_warnings else ("WARNING" if res.status == "READY" else "ERROR")
                title = "Dataset Scan Completed" if res.status == "READY" else "Dataset Scan Found Problems"
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,%s,%s,%s,'SOURCE_DATASET',%s)",
                    (audit_id, created_by, severity, title,
                     f"Scan for \"{name}\" completed with status {res.status}.", source_dataset_id),
                )
            cur.execute("UPDATE job_executions SET status='SUCCEEDED', finished_at=now() WHERE id=%s", (job_execution_id,))
        conn.commit()
        log.info("scan completed", scan_id=scan_id, status=res.status, pairs=res.matched_pair_count,
                 classes=res.class_count, errors=res.error_count, warnings=res.warning_count)

    def _fail(self, conn, source_dataset_id, scan_id, job_execution_id, correlation_id, name, created_by, code, message):
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE source_dataset_scans SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                (code, message[:1000], scan_id),
            )
            cur.execute("UPDATE source_datasets SET status='INVALID', updated_at=now() WHERE id=%s", (source_dataset_id,))
            cur.execute(
                "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                "result, correlation_id, error_code, error_message) VALUES ('WORKER',%s,'SOURCE_DATASET_SCAN_FAILED',"
                "'SOURCE_DATASET_SCAN',%s,'FAILURE',%s,%s,%s) RETURNING id",
                (self.cfg.consumer, scan_id, correlation_id, code, message[:1000]),
            )
            audit_id = cur.fetchone()[0]
            if created_by:
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'ERROR','Dataset Scan Failed',%s,'SOURCE_DATASET',%s)",
                    (audit_id, created_by, f"Scan for \"{name}\" failed: {code}.", source_dataset_id),
                )
            cur.execute("UPDATE job_executions SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                        (code, message[:1000], job_execution_id))
        conn.commit()
        log.error("scan failed", scan_id=scan_id, error_code=code, detail=message[:200])

    def _scan_training_dataset(self, conn, payload: dict) -> None:
        training_dataset_id = payload["training_dataset_id"]
        job_execution_id = payload["job_execution_id"]
        assignment_token = payload["assignment_token"]
        correlation_id = payload.get("correlation_id")
        log.info("training dataset scan dispatched", job_execution_id=job_execution_id,
                 training_dataset_id=training_dataset_id, correlation_id=correlation_id)

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE job_executions SET status='CLAIMED', claimed_at=now() "
                "WHERE id=%s AND assignment_token=%s AND status='ASSIGNED' RETURNING id",
                (job_execution_id, assignment_token),
            )
            if cur.fetchone() is None:
                log.warn("execution not claimable", job_execution_id=job_execution_id)
                return
            cur.execute("UPDATE job_executions SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=%s", (job_execution_id,))
            cur.execute(
                "SELECT td.name, td.dataset_type_id, td.relative_path, td.created_by_user_id, "
                "td.task_type, dt.training_dataset_path "
                "FROM training_datasets td JOIN dataset_types dt ON dt.id=td.dataset_type_id WHERE td.id=%s",
                (training_dataset_id,),
            )
            row = cur.fetchone()
            conn.commit()

        with joblog.Capture(self.storage, self.cfg.pg_conninfo(), self.cfg.consumer, job_execution_id):
            if row is None:
                self._fail_training_dataset(conn, training_dataset_id, job_execution_id, correlation_id,
                                           "?", None, "TRAINING_DATASET_NOT_FOUND", "training dataset not found")
                return

            try:
                (name, dataset_type_id, relative_path, created_by, task_type, training_dataset_path) = row
                if not training_dataset_path:
                    raise ScanError("DATASET_TYPE_PATH_NOT_SET", "dataset type has no training_dataset_path configured")

                joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 10, "Validating dataset directory")
                data_yaml = os.path.join(training_dataset_path, relative_path, "data.yaml")
                if not os.path.isfile(data_yaml):
                    raise ScanError("TRAINING_DATA_YAML_MISSING", f"data.yaml not found: {data_yaml}")

                if _has_symlink_component(training_dataset_path, os.path.join(training_dataset_path, relative_path)) or \
                   os.path.islink(os.path.join(training_dataset_path, relative_path)):
                    raise ScanError("DATASET_PATH_SYMLINK_NOT_ALLOWED", "dataset path traverses a symlink")

                res = self._validate_training_dataset(data_yaml, relative_path, task_type)
                joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 80,
                                f"Verified train={res['train_count']}, val={res['val_count']}, test={res['test_count']}")
                self._complete_training_dataset(conn, training_dataset_id, job_execution_id, correlation_id, name, created_by, res)
                joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 100, "Validation complete")
            except ScanError as se:
                self._fail_training_dataset(conn, training_dataset_id, job_execution_id, correlation_id, name, created_by, se.code, se.message)
            except Exception as e:  # noqa: BLE001
                self._fail_training_dataset(conn, training_dataset_id, job_execution_id, correlation_id, name, created_by,
                                           "TRAINING_DATASET_SCAN_FAILED", str(e)[:300])

    def _validate_training_dataset(self, data_yaml_path: str, rel_path: str, task_type: str) -> dict:
        try:
            import yaml
            with open(data_yaml_path, "r") as f:
                data = yaml.safe_load(f)
        except Exception as e:
            raise ScanError("TRAINING_DATA_YAML_INVALID", f"failed to parse data.yaml: {str(e)[:200]}")

        if not isinstance(data, dict):
            raise ScanError("TRAINING_DATA_YAML_INVALID", "data.yaml root must be a dict")

        path_val = data.get("path")
        names = data.get("names", {})
        if not path_val:
            raise ScanError("TRAINING_DATA_YAML_INVALID", "data.yaml missing 'path' key")
        if not isinstance(names, dict):
            raise ScanError("TRAINING_DATA_YAML_INVALID", "data.yaml 'names' must be a dict")

        classes_hash = hashlib.sha256(
            "\n".join(f"{i}:{nm}" for i, nm in sorted(names.items())).encode("utf-8")
        ).hexdigest()

        train_dir = os.path.join(os.path.dirname(data_yaml_path), "images", "train")
        val_dir = os.path.join(os.path.dirname(data_yaml_path), "images", "val")
        test_dir = os.path.join(os.path.dirname(data_yaml_path), "images", "test")

        train_count = sum(1 for f in os.listdir(train_dir) if os.path.isfile(os.path.join(train_dir, f))) if os.path.isdir(train_dir) else 0
        val_count = sum(1 for f in os.listdir(val_dir) if os.path.isfile(os.path.join(val_dir, f))) if os.path.isdir(val_dir) else 0
        test_count = sum(1 for f in os.listdir(test_dir) if os.path.isfile(os.path.join(test_dir, f))) if os.path.isdir(test_dir) else 0

        if train_count + val_count + test_count == 0:
            raise ScanError("TRAINING_DATASET_NO_IMAGES", "no images found in splits")

        self._assert_label_geometry(os.path.dirname(data_yaml_path), task_type)

        return {
            "classes_hash": classes_hash,
            "class_count": len(names),
            "train_count": train_count,
            "val_count": val_count,
            "test_count": test_count,
            "status": "READY",
        }

    def _assert_label_geometry(self, root: str, task_type: str) -> None:
        """A registered directory declares its task type at creation; nothing on disk
        forces the two to agree. Sample a label file and compare field counts so a
        DETECT/OBB mix-up fails here rather than deep inside Ultralytics.

        DETECT rows are `cls cx cy w h` (5 fields); OBB rows are `cls x1 y1 ... x4 y4` (9).

        Unlike a BUILT dataset, nothing here is rewritten — the directory is handed to
        Ultralytics as-is — so the optional trailing confidence column that the scanner
        tolerates on source datasets is rejected here: Ultralytics would fail on it.
        """
        expected = {"DETECT": 5, "OBB": 9}.get(task_type)
        if expected is None:
            return

        for split in ("train", "val", "test"):
            labels_dir = os.path.join(root, "labels", split)
            if not os.path.isdir(labels_dir):
                continue
            for entry in sorted(os.listdir(labels_dir)):
                if not entry.endswith(".txt"):
                    continue
                full = os.path.join(labels_dir, entry)
                if not os.path.isfile(full) or os.path.islink(full):
                    continue
                try:
                    with open(full, "r") as f:
                        for line in f:
                            fields = line.split()
                            if not fields:
                                continue  # blank line — a legitimately empty label row
                            if len(fields) != expected:
                                extra = (
                                    " — this looks like prediction output with a trailing "
                                    "confidence column; re-export the labels without it, or "
                                    "register the source dataset and build instead (the build "
                                    "strips confidence)"
                                    if len(fields) == expected + 1 else ""
                                )
                                raise ScanError(
                                    "TRAINING_DATASET_TASK_TYPE_MISMATCH",
                                    f"{task_type} expects {expected} fields per label row, "
                                    f"found {len(fields)} in labels/{split}/{entry}{extra}",
                                )
                            return  # one well-formed row is enough to confirm the geometry
                except OSError as e:
                    raise ScanError("TRAINING_DATASET_LABEL_UNREADABLE", str(e)[:200])

    def _complete_training_dataset(self, conn, training_dataset_id, job_execution_id, correlation_id, name, created_by, res):
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE training_datasets SET status=%s, ready_at=now(), build_finished_at=now(), "
                "classes_hash=%s, class_count=%s, train_count=%s, val_count=%s, test_count=%s "
                "WHERE id=%s",
                (res["status"], res["classes_hash"], res["class_count"], res["train_count"],
                 res["val_count"], res["test_count"], training_dataset_id),
            )
            cur.execute(
                "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                "result, correlation_id, metadata) VALUES ('WORKER',%s,'TRAINING_DATASET_SCANNED',"
                "'TRAINING_DATASET',%s,'SUCCESS',%s,%s) RETURNING id",
                (self.cfg.consumer, training_dataset_id, correlation_id,
                 json.dumps({"status": res["status"], "class_count": res["class_count"],
                            "train": res["train_count"], "val": res["val_count"], "test": res["test_count"]})),
            )
            audit_id = cur.fetchone()[0]
            if created_by:
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'SUCCESS','Training Dataset Ready',%s,'TRAINING_DATASET',%s)",
                    (audit_id, created_by,
                     f"Training dataset \"{name}\" ready for training. "
                     f"Classes: {res['class_count']}, Train: {res['train_count']}, Val: {res['val_count']}, Test: {res['test_count']}.",
                     training_dataset_id),
                )
            cur.execute("UPDATE job_executions SET status='SUCCEEDED', finished_at=now() WHERE id=%s", (job_execution_id,))
        conn.commit()
        log.info("training dataset scan completed", training_dataset_id=training_dataset_id, status=res["status"],
                classes=res["class_count"], train=res["train_count"], val=res["val_count"], test=res["test_count"])

    def _fail_training_dataset(self, conn, training_dataset_id, job_execution_id, correlation_id, name, created_by, code, message):
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute(
                # INVALID, matching the build path — the API lets INVALID be resubmitted.
                "UPDATE training_datasets SET status='INVALID', build_finished_at=now(), "
                "failure_code=%s, failure_message=%s WHERE id=%s",
                (code, message[:1000], training_dataset_id),
            )
            cur.execute(
                "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                "result, correlation_id, error_code, error_message) VALUES ('WORKER',%s,'TRAINING_DATASET_SCAN_FAILED',"
                "'TRAINING_DATASET',%s,'FAILURE',%s,%s,%s) RETURNING id",
                (self.cfg.consumer, training_dataset_id, correlation_id, code, message[:1000]),
            )
            audit_id = cur.fetchone()[0]
            if created_by:
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'ERROR','Training Dataset Scan Failed',%s,'TRAINING_DATASET',%s)",
                    (audit_id, created_by, f"Training dataset \"{name}\" scan failed: {code}.", training_dataset_id),
                )
            cur.execute("UPDATE job_executions SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                        (code, message[:1000], job_execution_id))
        conn.commit()
        log.error("training dataset scan failed", training_dataset_id=training_dataset_id, error_code=code, detail=message[:200])


class ScanError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def main() -> None:
    cfg = Config()
    from .registry import WorkerRegistry

    reg = WorkerRegistry(cfg.pg_conninfo(), cfg.consumer, "DATASET")
    reg.start()
    worker = DatasetWorker(cfg)
    while True:
        try:
            worker.run()
        except KeyboardInterrupt:
            reg.stop()
            log.info("shutting down")
            break
        except Exception as e:  # noqa: BLE001
            log.error("worker loop crashed, restarting", error=str(e)[:300])
            time.sleep(3)


if __name__ == "__main__":
    main()
