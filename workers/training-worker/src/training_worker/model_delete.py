"""Unlinks a model's .pt after the API has already soft-deleted the DB row.

Mirrors model_scan.py: fire-and-forget over the outbox, no job_executions claim
lifecycle (there's nothing to assign/heartbeat — this is a single file removal).
Only this worker has filesystem access to the Model Root, so the actual unlink
has to happen here rather than synchronously in the API.
"""
import json
import os

from . import log


class ModelDeleter:
    def __init__(self, conn, cfg) -> None:
        self.conn = conn
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        model_id = payload["model_id"]
        model_path = payload.get("model_path")
        correlation_id = payload.get("correlation_id")
        log.info("model delete dispatched", model_id=model_id, model_path=model_path)

        if not model_path:
            log.warn("model delete: no model_path on payload, nothing to unlink", model_id=model_id)
            self._audit(model_id, correlation_id, "MODEL_FILE_UNLINKED", "SUCCESS", {"skipped": "no_model_path"})
            return

        try:
            if os.path.isfile(model_path) and not os.path.islink(model_path):
                os.remove(model_path)
                log.info("model file unlinked", model_id=model_id, path=model_path)
                self._audit(model_id, correlation_id, "MODEL_FILE_UNLINKED", "SUCCESS", {"path": model_path})
            else:
                log.warn("model delete: file already gone", model_id=model_id, path=model_path)
                self._audit(model_id, correlation_id, "MODEL_FILE_UNLINKED", "SUCCESS", {"skipped": "already_gone", "path": model_path})
        except OSError as e:
            log.error("model file unlink failed", model_id=model_id, path=model_path, error=str(e)[:300])
            self._audit(model_id, correlation_id, "MODEL_FILE_UNLINKED", "FAILURE", {"path": model_path},
                        error_code="MODEL_FILE_UNLINK_FAILED", error_message=str(e)[:500])

    def _audit(self, resource_id, correlation_id, action, result, metadata, error_code=None, error_message=None) -> None:
        try:
            with self.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, "
                    "resource_id, result, correlation_id, metadata, error_code, error_message) "
                    "VALUES ('WORKER',%s,%s,'MODEL',%s,%s,%s,%s,%s,%s)",
                    (self.cfg.consumer, action, resource_id, result, correlation_id,
                     json.dumps(metadata), error_code, error_message),
                )
            self.conn.commit()
        except Exception as e:  # noqa: BLE001
            self.conn.rollback()
            log.warn("could not record model delete audit", error=str(e)[:160])
