"""Background execution heartbeat.

Long GPU/CPU work (Ultralytics train/val) blocks the worker thread, so the
scheduler's stale-execution reconciliation (doc 11 §18) would eventually mark a
still-running job LOST. This context manager keeps `job_executions.heartbeat_at`
fresh from a daemon thread with its own DB connection while the work runs.
"""
import threading

import psycopg

from . import log


class Heartbeat:
    def __init__(self, conninfo: str, job_execution_id: str, interval_s: int = 20) -> None:
        self.conninfo = conninfo
        self.job_execution_id = job_execution_id
        self.interval_s = max(2, interval_s)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _run(self) -> None:
        # Beat only while the execution is still RUNNING; a terminal status means we stop touching it.
        while not self._stop.wait(self.interval_s):
            try:
                with psycopg.connect(self.conninfo) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE job_executions SET heartbeat_at=now() WHERE id=%s AND status='RUNNING'",
                            (self.job_execution_id,),
                        )
                    conn.commit()
            except Exception as e:  # noqa: BLE001
                log.warn("heartbeat update failed", job_execution_id=self.job_execution_id, error=str(e)[:200])

    def __enter__(self) -> "Heartbeat":
        self._thread = threading.Thread(target=self._run, name="exec-heartbeat", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
