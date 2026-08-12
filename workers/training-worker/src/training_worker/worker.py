import time

import psycopg
import redis as redislib

from . import log
from .benchmarker import Benchmarker
from .config import Config
from .storage import Storage
from .trainer import Trainer

TRAINING_EVENT = "job.training.dispatch"
BENCHMARK_EVENT = "job.benchmark.dispatch"
MODEL_SCAN_EVENT = "job.model_scan.dispatch"
CONVERSION_EVENT = "job.conversion.dispatch"
MODEL_DELETE_EVENT = "job.model_delete.dispatch"


class TrainingWorker:
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
        log.info("training-worker ready", stream=self.cfg.stream, group=self.cfg.group,
                 consumer=self.cfg.consumer, device=self.cfg.device)

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
            start_id, messages = self.redis.xautoclaim(
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
        if event_type not in (TRAINING_EVENT, BENCHMARK_EVENT, MODEL_SCAN_EVENT, CONVERSION_EVENT, MODEL_DELETE_EVENT):
            return
        import json
        payload = json.loads(fields.get("payload", "{}"))
        with psycopg.connect(self.cfg.pg_conninfo()) as conn:
            if event_type == TRAINING_EVENT:
                Trainer(conn, self.storage, self.cfg).run(payload)
            elif event_type == MODEL_SCAN_EVENT:
                # Reading .pt metadata needs torch, which only this worker has.
                from .model_scan import ModelScanner
                ModelScanner(conn, self.cfg).run(payload)
            elif event_type == CONVERSION_EVENT:
                from .converter import Converter
                Converter(conn, self.storage, self.cfg).run(payload)
            elif event_type == MODEL_DELETE_EVENT:
                from .model_delete import ModelDeleter
                ModelDeleter(conn, self.cfg).run(payload)
            else:
                Benchmarker(conn, self.storage, self.cfg).run(payload)


def main() -> None:
    cfg = Config()
    from .registry import WorkerRegistry

    reg = WorkerRegistry(cfg.pg_conninfo(), cfg.consumer, "TRAINING")
    reg.start()
    worker = TrainingWorker(cfg)
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
