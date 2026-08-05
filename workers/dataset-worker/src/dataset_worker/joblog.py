import contextlib
import io
import uuid

import psycopg

from . import log


def progress(pg_conninfo: str, job_execution_id: str, pct: float, message: str) -> None:
    """Best-effort live progress update on job_executions.

    Uses its own autocommit connection so the update is visible even while the
    task's main transaction is open or idle. Failures are swallowed — progress
    is a nicety, never a task-killer.
    """
    try:
        with psycopg.connect(pg_conninfo, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE job_executions SET progress_percent=%s, progress_message=%s, "
                    "heartbeat_at=now() WHERE id=%s",
                    (min(max(round(pct), 0), 100), message[:200], job_execution_id),
                )
    except Exception as e:  # noqa: BLE001
        log.warn("progress update failed", job_execution_id=job_execution_id, error=str(e)[:200])


class Capture:
    """Redirects a task's stdout/stderr into a buffer and, on exit, persists it
    as a JOB_EXECUTION-owned TRAIN_LOG artifact (same pattern as the training
    worker's training.log). Artifacts are immutable once written; a failed
    upload or insert is logged, never raised.
    """

    def __init__(self, storage, pg_conninfo: str, consumer: str, job_execution_id: str) -> None:
        self.storage = storage
        self.pg_conninfo = pg_conninfo
        self.consumer = consumer
        self.job_execution_id = job_execution_id
        self._buf = io.StringIO()
        self._stack: contextlib.ExitStack | None = None

    def __enter__(self) -> "Capture":
        self._stack = contextlib.ExitStack()
        self._stack.enter_context(contextlib.redirect_stdout(self._buf))
        self._stack.enter_context(contextlib.redirect_stderr(self._buf))
        return self

    def __exit__(self, *exc: object) -> None:
        if self._stack is not None:
            self._stack.close()
        content = self._buf.getvalue()
        if not content.strip():
            return
        artifact_id = str(uuid.uuid4())
        key = f"artifacts/job-execution/{self.job_execution_id}/{artifact_id}/job.log"
        try:
            info = self.storage.put_bytes(key, content.encode("utf-8"), "text/plain")
        except Exception as e:  # noqa: BLE001
            log.warn("job log upload skipped", job_execution_id=self.job_execution_id, error=str(e)[:200])
            return
        try:
            with psycopg.connect(self.pg_conninfo, autocommit=True) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, "
                        "source_execution_id, status, bucket_name, object_key, filename, mime_type, "
                        "file_size_bytes, checksum, is_primary, created_by_actor_type, "
                        "created_by_actor_ref, verified_at) "
                        "VALUES (%s,'JOB_EXECUTION',%s,'TRAIN_LOG',%s,'VERIFIED',%s,%s,'job.log','text/plain',"
                        "%s,%s,false,'WORKER',%s,now())",
                        (artifact_id, self.job_execution_id, self.job_execution_id, info["bucket"],
                         info["object_key"], info["size"], info["checksum"], self.consumer),
                    )
        except Exception as e:  # noqa: BLE001
            log.warn("job log artifact insert failed", job_execution_id=self.job_execution_id, error=str(e)[:200])
