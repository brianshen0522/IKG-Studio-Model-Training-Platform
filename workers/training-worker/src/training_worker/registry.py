import json
import socket
import threading

import psycopg

from . import log
from .gpu_probe import GpuProbe


class WorkerRegistry:
    def __init__(self, conninfo, worker_key, worker_type, interval_s=15):
        self.conninfo = conninfo
        self.worker_key = worker_key
        self.worker_type = worker_type
        self.interval_s = max(5, interval_s)
        self._stop = threading.Event()
        self._thread = None
        # Samples GPU telemetry continuously in the background; the heartbeat below
        # only reports what it has already collected (see gpu_probe for why).
        self._gpu = GpuProbe()

    def _versions(self):
        py = ".".join(map(str, __import__("sys").version_info[:3]))
        torch_v = ultra_v = cuda_v = None
        try:
            import torch

            torch_v = torch.__version__
            cuda_v = getattr(torch.version, "cuda", None)
        except Exception as e:  # noqa: BLE001
            # Optional at import time: the version strings are cosmetic, so a missing
            # or broken torch must not stop the worker from registering.
            log.warn("torch version probe failed", error=str(e)[:200])
        try:
            import ultralytics

            ultra_v = ultralytics.__version__
        except Exception as e:  # noqa: BLE001
            log.warn("ultralytics version probe failed", error=str(e)[:200])
        return py, torch_v, ultra_v, cuda_v

    def _capabilities(self):
        """Version strings + the GPU probe's latest snapshot, as the `capabilities` jsonb."""
        py, torch_v, ultra_v, cuda_v = self._versions()
        return py, torch_v, ultra_v, cuda_v, self._gpu.snapshot()

    def register(self):
        py, torch_v, ultra_v, cuda_v, caps = self._capabilities()
        with psycopg.connect(self.conninfo) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO workers (worker_key, worker_type, hostname, status, python_version, "
                    "torch_version, ultralytics_version, cuda_version, capabilities, last_heartbeat_at, registered_at, updated_at) "
                    "VALUES (%s,%s,%s,'ONLINE',%s,%s,%s,%s,%s,now(),now(),now()) "
                    "ON CONFLICT (worker_key) DO UPDATE SET status='ONLINE', hostname=EXCLUDED.hostname, "
                    "python_version=EXCLUDED.python_version, torch_version=EXCLUDED.torch_version, "
                    "ultralytics_version=EXCLUDED.ultralytics_version, cuda_version=EXCLUDED.cuda_version, "
                    "capabilities=EXCLUDED.capabilities, "
                    "last_heartbeat_at=now(), updated_at=now(), disabled_at=NULL "
                    "RETURNING id",
                    (
                        self.worker_key,
                        self.worker_type,
                        socket.gethostname(),
                        py,
                        torch_v,
                        ultra_v,
                        cuda_v,
                        json.dumps(caps),
                    ),
                )
                row = cur.fetchone()
                worker_id = row[0] if row else None
                if worker_id is not None:
                    self._sync_gpus(cur, worker_id, caps.get("devices", []))
            conn.commit()
        log.info(
            "worker registered",
            worker_key=self.worker_key,
            worker_type=self.worker_type,
        )

    def _sync_gpus(self, cur, worker_id, devices):
        """Upsert the physical GPU inventory into `worker_gpus`.

        `capabilities` carries the live telemetry; this table is the *identity* of each
        card, so a job execution can be tied to the GPU it ran on (`job_execution_gpus`
        FKs here with ON DELETE RESTRICT, hence rows are only ever upserted, never
        deleted — a card that disappears just stops having `last_seen_at` refreshed).

        Keyed on gpu_uuid, which is stable across reboots and reindexing, unlike the
        CUDA index. Devices without a UUID (the torch-only fallback) are skipped: no
        stable identity means a synthetic key would create a duplicate row per restart.
        """
        for d in devices:
            gpu_uuid = d.get("uuid")
            if not gpu_uuid:
                continue
            total_mb = d.get("memory_total_mb")
            total_bytes = int(total_mb) * 1024 * 1024 if total_mb else 0
            try:
                cur.execute(
                    "INSERT INTO worker_gpus (worker_id, gpu_uuid, gpu_index, name, memory_total_bytes, last_seen_at) "
                    "VALUES (%s,%s,%s,%s,%s,now()) "
                    "ON CONFLICT (gpu_uuid) DO UPDATE SET worker_id=EXCLUDED.worker_id, "
                    "gpu_index=EXCLUDED.gpu_index, name=EXCLUDED.name, "
                    "memory_total_bytes=EXCLUDED.memory_total_bytes, last_seen_at=now()",
                    (worker_id, gpu_uuid, d.get("index", 0), d.get("name") or "GPU", total_bytes),
                )
            except Exception as e:  # noqa: BLE001
                # Inventory bookkeeping must never take down the heartbeat.
                log.warn("worker_gpus upsert failed", gpu_uuid=gpu_uuid, error=str(e)[:200])

    def _run(self):
        while not self._stop.wait(self.interval_s):
            try:
                _py, _torch_v, _ultra_v, _cuda_v, caps = self._capabilities()
                with psycopg.connect(self.conninfo) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE workers SET last_heartbeat_at=now(), status='ONLINE', "
                            "capabilities=%s, updated_at=now() "
                            "WHERE worker_key=%s AND disabled_at IS NULL "
                            "RETURNING id",
                            (json.dumps(caps), self.worker_key),
                        )
                        row = cur.fetchone()
                        if row is not None:
                            self._sync_gpus(cur, row[0], caps.get("devices", []))
                    conn.commit()
            except Exception as e:
                log.warn(
                    "worker heartbeat failed",
                    worker_key=self.worker_key,
                    error=str(e)[:200],
                )

    def start(self):
        self._gpu.start()
        try:
            self.register()
        except Exception as e:
            log.warn("worker registration failed", error=str(e)[:200])
        self._thread = threading.Thread(
            target=self._run, name="worker-heartbeat", daemon=True
        )
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._gpu.stop()
        try:
            with psycopg.connect(self.conninfo) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE workers SET status='OFFLINE', updated_at=now() WHERE worker_key=%s",
                        (self.worker_key,),
                    )
                conn.commit()
        except Exception as e:  # noqa: BLE001
            # Shutdown is best-effort: the scheduler marks stale workers OFFLINE anyway.
            log.warn("worker offline mark failed", worker_key=self.worker_key, error=str(e)[:200])
