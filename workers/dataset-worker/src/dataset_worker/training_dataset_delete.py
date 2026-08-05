"""Removes a BUILT training dataset's directory after the API has already
soft-deleted the DB row. Fire-and-forget over the outbox, same shape as
model_delete.py in training-worker: no job_executions claim lifecycle, this
is a single directory removal.

The API only dispatches this for origin='BUILT' — that directory is the
platform's own copy under dataset_types.training_dataset_path. origin=
'REGISTERED' datasets never reach this handler; their directory is left
alone (same spirit as source datasets being read-only).
"""
import json
import os
import shutil

from . import log


class TrainingDatasetDeleter:
    def __init__(self, conn, cfg) -> None:
        self.conn = conn
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        dataset_id = payload["dataset_id"]
        correlation_id = payload.get("correlation_id")

        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT d.relative_path, dt.training_dataset_path "
                "FROM training_datasets d JOIN dataset_types dt ON dt.id = d.dataset_type_id "
                "WHERE d.id = %s",
                (dataset_id,),
            )
            row = cur.fetchone()

        if not row or not row[0] or not row[1]:
            log.warn("training dataset delete: no relative_path/root, nothing to remove", dataset_id=dataset_id)
            self._audit(dataset_id, correlation_id, "SUCCESS", {"skipped": "no_path"})
            return

        relative_path, root = row
        target = os.path.join(root, relative_path)
        log.info("training dataset delete dispatched", dataset_id=dataset_id, path=target)

        try:
            if os.path.isdir(target) and not os.path.islink(target):
                shutil.rmtree(target)
                log.info("training dataset directory removed", dataset_id=dataset_id, path=target)
                self._audit(dataset_id, correlation_id, "SUCCESS", {"path": target})
            else:
                log.warn("training dataset delete: directory already gone", dataset_id=dataset_id, path=target)
                self._audit(dataset_id, correlation_id, "SUCCESS", {"skipped": "already_gone", "path": target})
        except OSError as e:
            log.error("training dataset directory removal failed", dataset_id=dataset_id, path=target, error=str(e)[:300])
            self._audit(dataset_id, correlation_id, "FAILURE", {"path": target},
                        error_code="TRAINING_DATASET_DIR_REMOVE_FAILED", error_message=str(e)[:500])

    def _audit(self, resource_id, correlation_id, result, metadata, error_code=None, error_message=None) -> None:
        try:
            with self.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, "
                    "resource_id, result, correlation_id, metadata, error_code, error_message) "
                    "VALUES ('WORKER',%s,'TRAINING_DATASET_FILES_DELETED','TRAINING_DATASET',%s,%s,%s,%s,%s,%s)",
                    (self.cfg.consumer, resource_id, result, correlation_id,
                     json.dumps(metadata), error_code, error_message),
                )
            self.conn.commit()
        except Exception as e:  # noqa: BLE001
            self.conn.rollback()
            log.warn("could not record training dataset delete audit", error=str(e)[:160])
