"""OpenVINO conversion (admin-triggered export of an existing AVAILABLE model).

Flow: claim execution → model_conversions QUEUED→RUNNING → real Ultralytics
`model.export(format='openvino')` → the IR (.xml/.bin/...) is zipped → uploaded to
MinIO as one immutable `.zip` Artifact owned by the MODEL_CONVERSION resource →
RUNNING→SUCCEEDED with artifact_id. Nothing is written to the model root; all scratch
lives under the process temp dir and is removed afterwards. Status changes are guarded
conditional UPDATEs, mirroring trainer.py.
"""
import contextlib
import hashlib
import io
import json
import os
import shutil
import tempfile
import uuid
import zipfile

from . import log
from .heartbeat import Heartbeat


class ConversionError(Exception):
    def __init__(self, stage: str, code: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# Platform-owned export arguments, mirrored from conversions.service.ts (RESERVED_ARGS).
# `model`/`format` are derived from the conversion itself; the rest would point export
# at other data or write outside the scratch dir.
_RESERVED_ARGS = frozenset({
    "model", "format", "source", "data", "project", "name", "save_dir", "exist_ok",
    "resume", "mode",
})
# INT8 needs a calibration dataset; a conversion has none.
_UNSUPPORTED_ARGS = frozenset({"int8", "quantize"})
# Passed explicitly by _convert and therefore not taken from args.
_EXPLICIT_ARGS = frozenset({"imgsz"})


class Converter:
    def __init__(self, conn, storage, cfg) -> None:
        self.conn = conn
        self.storage = storage
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        conversion_id = payload["conversion_id"]
        model_id = payload["model_id"]
        job_execution_id = payload["job_execution_id"]
        assignment_token = payload["assignment_token"]
        correlation_id = payload.get("correlation_id")
        log.info("conversion dispatched", conversion_id=conversion_id, model_id=model_id)

        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE job_executions SET status='CLAIMED', claimed_at=now() "
                "WHERE id=%s AND assignment_token=%s AND status='ASSIGNED' RETURNING id",
                (job_execution_id, assignment_token),
            )
            if cur.fetchone() is None:
                log.warn("conversion execution not claimable", job_execution_id=job_execution_id)
                return
            cur.execute(
                "UPDATE job_executions SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=%s",
                (job_execution_id,),
            )
            cur.execute(
                "UPDATE model_conversions SET status='RUNNING', started_at=now(), row_version=row_version+1 "
                "WHERE id=%s AND status='QUEUED' RETURNING id",
                (conversion_id,),
            )
            if cur.fetchone() is None:
                log.warn("conversion not in QUEUED (already handled)", conversion_id=conversion_id)
                self.conn.rollback()
                cur.execute("UPDATE job_executions SET status='CANCELLED', finished_at=now() WHERE id=%s", (job_execution_id,))
                self.conn.commit()
                return
        self.conn.commit()

        scratch = tempfile.mkdtemp(prefix=f"conversion-{conversion_id}-")
        try:
            self._audit(conversion_id, correlation_id, "MODEL_CONVERSION_RUNNING", "SUCCESS", {})
            with Heartbeat(self.cfg.pg_conninfo(), job_execution_id, self.cfg.heartbeat_interval_s):
                zip_path, names = self._convert(model_id, conversion_id, scratch)
            self._complete(conversion_id, job_execution_id, correlation_id, zip_path, names)
        except ConversionError as ce:
            self._fail(conversion_id, job_execution_id, correlation_id, ce.stage, ce.code, ce.message)
        except Exception as e:  # noqa: BLE001
            self._fail(conversion_id, job_execution_id, correlation_id, "CONVERSION", "MODEL_CONVERSION_FAILED", str(e)[:500])
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def _load_model(self, model_id: str) -> dict:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT m.name, m.task_type, m.model_path, m.relative_path, m.architecture_metadata, "
                "dt.model_path "
                "FROM models m LEFT JOIN dataset_types dt ON dt.id = m.dataset_type_id WHERE m.id=%s",
                (model_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise ConversionError("VALIDATION", "MODEL_NOT_FOUND", "model not found")
        (name, task_type, model_path, relative_path, arch_meta, dt_model_path) = row
        pt_path = model_path or (os.path.join(dt_model_path, relative_path) if dt_model_path else None)
        if not pt_path or not os.path.isfile(pt_path):
            raise ConversionError("VALIDATION", "MODEL_FILE_MISSING", f"model file not found: {pt_path}")
        return {"name": name, "task_type": task_type, "pt_path": pt_path, "arch": arch_meta}

    def _parse_imgsz(self, value):
        if isinstance(value, (list, tuple)) and len(value) == 2:
            return [int(value[0]), int(value[1])]
        return int(value)

    def _export_overrides(self, args: dict) -> dict:
        try:
            from ultralytics.cfg import DEFAULT_CFG_DICT, check_cfg
        except Exception as e:  # noqa: BLE001
            raise ConversionError("PREPARATION", "CONVERSION_RUNTIME_UNAVAILABLE", f"ultralytics config unavailable: {e}")

        overrides, rejected = {}, []
        for key, value in (args or {}).items():
            if key in _EXPLICIT_ARGS:
                continue
            if key in _RESERVED_ARGS:
                rejected.append(f"{key} (set by the platform)")
                continue
            if key in _UNSUPPORTED_ARGS:
                rejected.append(f"{key} (requires calibration data)")
                continue
            if key not in DEFAULT_CFG_DICT:
                rejected.append(f"{key} (not a YOLO export argument)")
                continue
            overrides[key] = value
        if rejected:
            raise ConversionError("PREPARATION", "MODEL_CONVERSION_INVALID_ARGS",
                                  "unusable export arguments: " + ", ".join(sorted(rejected)))
        try:
            check_cfg({**overrides, "imgsz": args.get("imgsz", 640)}, hard=True)
        except Exception as e:  # noqa: BLE001
            raise ConversionError("PREPARATION", "MODEL_CONVERSION_INVALID_ARGS", str(e)[:400])
        return overrides

    def _convert(self, model_id: str, conversion_id: str, scratch: str) -> tuple:
        with self.conn.cursor() as cur:
            cur.execute("SELECT args FROM model_conversions WHERE id=%s", (conversion_id,))
            row = cur.fetchone()
        args = dict(row[0]) if row and row[0] else {}
        ctx = self._load_model(model_id)
        imgsz = self._parse_imgsz(args.get("imgsz", 640))
        extra = self._export_overrides(args)

        try:
            from ultralytics import YOLO
        except Exception as e:  # noqa: BLE001
            raise ConversionError("PREPARATION", "CONVERSION_RUNTIME_UNAVAILABLE", f"ultralytics import failed: {e}")

        log.info("starting openvino export", conversion_id=conversion_id, model=ctx["pt_path"],
                 imgsz=imgsz, device=self.cfg.device, overrides=sorted(extra) or None)
        export_dir = os.path.join(scratch, "run")
        try:
            model = YOLO(ctx["pt_path"])
        except Exception as e:  # noqa: BLE001
            raise ConversionError("PREPARATION", "MODEL_LOAD_FAILED", f"could not load model: {str(e)[:300]}")
        log_buf = io.StringIO()
        with contextlib.redirect_stdout(log_buf), contextlib.redirect_stderr(log_buf):
            out = model.export(
                format="openvino", imgsz=imgsz, device=self.cfg.device,
                project=scratch, name="run", **extra,
            )
        log_path = os.path.join(scratch, "export.log")
        with open(log_path, "w") as f:
            f.write(log_buf.getvalue())

        if out is None or not os.path.isdir(out):
            raise ConversionError("EXPORT", "MODEL_CONVERSION_NO_OUTPUT",
                                  f"export produced no OpenVINO model directory ({out})")
        zip_name = f"{_safe_stem(ctx['name'])}_openvino.zip"
        zip_path = os.path.join(scratch, zip_name)
        names = _zip_dir(out, zip_path)
        return zip_path, names

    def _complete(self, conversion_id, job_execution_id, correlation_id, zip_path, names) -> None:
        checksum = _sha256(zip_path)
        size = os.path.getsize(zip_path)
        artifact_id = str(uuid.uuid4())
        key = f"artifacts/model-conversion/{conversion_id}/{artifact_id}/{os.path.basename(zip_path)}"
        try:
            up = self.storage.put_file(key, zip_path, "application/zip")
        except Exception as e:  # noqa: BLE001
            raise ConversionError("POST_PROCESSING", "STORAGE_TEMPORARY_FAILURE", f"artifact upload failed: {str(e)[:300]}")

        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                "created_by_actor_type, created_by_actor_ref, verified_at) "
                "VALUES (%s,'MODEL_CONVERSION',%s,'OPENVINO_ZIP',%s,'VERIFIED',%s,%s,%s,'application/zip',%s,%s,true,'WORKER',%s,now())",
                (artifact_id, conversion_id, job_execution_id, up["bucket"], up["object_key"],
                 os.path.basename(zip_path), size, checksum, self.cfg.consumer),
            )
            cur.execute(
                "UPDATE model_conversions SET status='SUCCEEDED', artifact_id=%s, finished_at=now(), "
                "failure_code=NULL, failure_message=NULL, row_version=row_version+1 WHERE id=%s AND status='RUNNING' RETURNING id",
                (artifact_id, conversion_id),
            )
            if cur.fetchone() is None:
                raise ConversionError("POST_PROCESSING", "CONVERSION_STATE_LOST", "conversion left RUNNING before completion")
            cur.execute("UPDATE job_executions SET status='SUCCEEDED', finished_at=now(), progress_percent=100 WHERE id=%s", (job_execution_id,))
            aid = self._audit_cur(cur, conversion_id, correlation_id, "MODEL_CONVERSION_COMPLETED", "SUCCESS",
                                  {"artifact_id": artifact_id, "checksum": checksum[:12], "files": names}, resource_type="MODEL_CONVERSION")
            cur.execute(
                "SELECT requested_by_user_id FROM model_conversions WHERE id=%s",
                (conversion_id,),
            )
            requester = cur.fetchone()
            if requester and requester[0]:
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'SUCCESS','Conversion Completed',%s,'MODEL_CONVERSION',%s)",
                    (aid, requester[0], "OpenVINO conversion completed; download the .zip from the model page.", conversion_id),
                )
        self.conn.commit()
        log.info("conversion completed", conversion_id=conversion_id, artifact_id=artifact_id, checksum=checksum[:12])

    def _fail(self, conversion_id, job_execution_id, correlation_id, stage, code, message) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE model_conversions SET status='FAILED', failure_code=%s, failure_message=%s, "
                "finished_at=now(), row_version=row_version+1 WHERE id=%s AND status='RUNNING' RETURNING id",
                (code, message[:1000], conversion_id),
            )
            cur.execute("UPDATE job_executions SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                        (code, message[:1000], job_execution_id))
            aid = self._audit_cur(cur, conversion_id, correlation_id, "MODEL_CONVERSION_FAILED", "FAILURE",
                                  {"failure_stage": stage}, resource_type="MODEL_CONVERSION",
                                  error_code=code, error_message=message[:1000])
            cur.execute(
                "SELECT requested_by_user_id FROM model_conversions WHERE id=%s",
                (conversion_id,),
            )
            requester = cur.fetchone()
            if requester and requester[0]:
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'ERROR','Conversion Failed',%s,'MODEL_CONVERSION',%s)",
                    (aid, requester[0], f"OpenVINO conversion failed: {code}.", conversion_id),
                )
        self.conn.commit()
        log.error("conversion failed", conversion_id=conversion_id, stage=stage, error_code=code, detail=message[:200])

    def _audit(self, resource_id, correlation_id, action, result, metadata) -> None:
        with self.conn.cursor() as cur:
            self._audit_cur(cur, resource_id, correlation_id, action, result, metadata)
        self.conn.commit()

    def _audit_cur(self, cur, resource_id, correlation_id, action, result, metadata,
                   resource_type="MODEL_CONVERSION", error_code=None, error_message=None) -> int:
        cur.execute(
            "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
            "result, correlation_id, metadata, error_code, error_message) "
            "VALUES ('WORKER',%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (self.cfg.consumer, action, resource_type, resource_id, result, correlation_id,
             json.dumps(metadata), error_code, error_message),
        )
        return cur.fetchone()[0]


def _safe_stem(name: str) -> str:
    stem = name.strip().replace(" ", "-")
    stem = "".join(c for c in stem if c.isalnum() or c in "._-").strip("-._")
    return stem or "model"


def _zip_dir(src_dir: str, zip_path: str) -> list:
    """Zip the contents of the OpenVINO export directory (IR is a folder of files)."""
    names = []
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(src_dir):
            for fn in sorted(files):
                full = os.path.join(root, fn)
                arc = os.path.relpath(full, src_dir)
                zf.write(full, arc)
                names.append(arc)
    return names
