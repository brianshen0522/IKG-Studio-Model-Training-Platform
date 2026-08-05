import json
import socket
import threading

import psycopg

from . import log


class WorkerRegistry:
    def __init__(self, conninfo, worker_key, worker_type, interval_s=15):
        self.conninfo = conninfo
        self.worker_key = worker_key
        self.worker_type = worker_type
        self.interval_s = max(5, interval_s)
        self._stop = threading.Event()
        self._thread = None

    def _capabilities(self):
        py = ".".join(map(str, __import__("sys").version_info[:3]))
        torch_v = ultra_v = cuda_v = None
        devices = []
        try:
            import torch

            torch_v = torch.__version__
            cuda_v = getattr(torch.version, "cuda", None)
            if torch.cuda.is_available():
                for i in range(torch.cuda.device_count()):
                    free_b, total_b = torch.cuda.mem_get_info(i)
                    devices.append({
                        "index": i,
                        "name": torch.cuda.get_device_name(i),
                        "total_memory_mb": round(total_b / (1024 * 1024)),
                        "used_memory_mb": round((total_b - free_b) / (1024 * 1024)),
                    })
        except Exception:
            pass
        try:
            import ultralytics

            ultra_v = ultralytics.__version__
        except Exception:
            pass
        return py, torch_v, ultra_v, cuda_v, {"devices": devices}

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
                    "last_heartbeat_at=now(), updated_at=now(), disabled_at=NULL",
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
            conn.commit()
        log.info(
            "worker registered",
            worker_key=self.worker_key,
            worker_type=self.worker_type,
        )

    def _run(self):
        while not self._stop.wait(self.interval_s):
            try:
                _py, _torch_v, _ultra_v, _cuda_v, caps = self._capabilities()
                with psycopg.connect(self.conninfo) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE workers SET last_heartbeat_at=now(), status='ONLINE', "
                            "capabilities=%s, updated_at=now() "
                            "WHERE worker_key=%s AND disabled_at IS NULL",
                            (json.dumps(caps), self.worker_key),
                        )
                    conn.commit()
            except Exception as e:
                log.warn(
                    "worker heartbeat failed",
                    worker_key=self.worker_key,
                    error=str(e)[:200],
                )

    def start(self):
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
        try:
            with psycopg.connect(self.conninfo) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE workers SET status='OFFLINE', updated_at=now() WHERE worker_key=%s",
                        (self.worker_key,),
                    )
                conn.commit()
        except Exception:
            pass
