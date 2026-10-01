"""Records which physical GPU(s) a job execution occupies.

`job_execution_gpus` existed in the schema but nothing ever wrote to it, so the
dashboard had no way to say *which* job is loading a busy card — the single most
useful fact on a multi-GPU box. This fills it in for training and benchmark runs.

Resolution is `device=` (an Ultralytics index, or 'cpu'/'' for auto) → `worker_gpus`
row for this worker, keyed by index. Only cards already in the inventory are matched:
`WorkerRegistry._sync_gpus` upserts those on every heartbeat, and the FK is
ON DELETE RESTRICT, so an unknown index is skipped rather than invented.

Deliberately best-effort — bookkeeping must never fail a training run. Allocation
rows are released in a `finally`, and the scheduler's stale-execution reconcile is
the backstop for a worker that dies mid-run (the API filters allocations by live
execution status, so a leaked row cannot show up as active work).
"""
import psycopg

from . import log


def _parse_indices(device: str) -> list[int]:
    """'0' → [0]; '0,1' → [0, 1]; 'cpu'/''/'mps' → [].

    Anything that is not a plain CUDA index is skipped rather than raising: this runs
    in __init__, outside the try/except that guards the DB work, so an exception here
    would fail the *training run* over bookkeeping. `str.isdigit()` is not a sufficient
    guard on its own — it is True for superscripts like '²', which int() rejects with
    ValueError — so the conversion itself is also protected.
    """
    out: list[int] = []
    for part in str(device or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            # 'cpu', 'mps', 'cuda:0', '²' — not an index we can attribute.
            continue
    return out


class GpuAllocation:
    """Context manager claiming the GPUs an execution runs on.

    Usage:
        with GpuAllocation(conninfo, job_execution_id, worker_key, device):
            ...run the work...
    """

    def __init__(self, conninfo: str, job_execution_id: str, worker_key: str, device: str) -> None:
        self.conninfo = conninfo
        self.job_execution_id = job_execution_id
        self.worker_key = worker_key
        self.indices = _parse_indices(device)

    def __enter__(self) -> "GpuAllocation":
        if not self.indices:
            return self  # CPU run, or auto-detect: nothing to attribute.
        try:
            # Its own connection: the caller's is mid-transaction for job state, and
            # this must commit independently so the dashboard sees it while work runs.
            with psycopg.connect(self.conninfo) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO job_execution_gpus (job_execution_id, worker_gpu_id, allocated_at) "
                        "SELECT %s, wg.id, now() FROM worker_gpus wg "
                        "JOIN workers w ON w.id = wg.worker_id "
                        "WHERE w.worker_key = %s AND wg.gpu_index = ANY(%s) "
                        "ON CONFLICT (job_execution_id, worker_gpu_id) DO UPDATE SET "
                        "allocated_at = now(), released_at = NULL",
                        (self.job_execution_id, self.worker_key, self.indices),
                    )
                conn.commit()
        except Exception as e:  # noqa: BLE001
            log.warn("gpu allocation record failed", job_execution_id=self.job_execution_id,
                     error=str(e)[:200])
        return self

    def __exit__(self, *_exc: object) -> None:
        if not self.indices:
            return
        try:
            with psycopg.connect(self.conninfo) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE job_execution_gpus SET released_at = now() "
                        "WHERE job_execution_id = %s AND released_at IS NULL",
                        (self.job_execution_id,),
                    )
                conn.commit()
        except Exception as e:  # noqa: BLE001
            log.warn("gpu allocation release failed", job_execution_id=self.job_execution_id,
                     error=str(e)[:200])
