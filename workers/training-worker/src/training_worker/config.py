import os
import socket


class Config:
    def __init__(self) -> None:
        self.pg_host = os.environ.get("POSTGRES_HOST", "localhost")
        self.pg_port = os.environ.get("POSTGRES_PORT", "5432")
        self.pg_db = os.environ.get("POSTGRES_DB", "model_trainer")
        self.pg_user = os.environ.get("POSTGRES_USER", "worker_role")
        self.pg_password = os.environ.get("POSTGRES_PASSWORD", "")

        self.redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
        self.stream = os.environ.get("EVENTS_STREAM", "events")
        # Distinct consumer group so this worker fans-out independently of the dataset worker.
        self.group = os.environ.get("WORKER_GROUP", "training-worker")
        self.consumer = os.environ.get("WORKER_KEY", f"training-worker-{socket.gethostname()}")
        self.block_ms = int(os.environ.get("WORKER_BLOCK_MS", "5000"))

        # Reclaim dispatch messages a dead consumer left in the group's pending list.
        self.reclaim_idle_s = int(os.environ.get("WORKER_RECLAIM_IDLE_S", "90"))

        self.minio_endpoint = os.environ.get("MINIO_ENDPOINT", "localhost:9000")
        self.minio_access_key = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
        self.minio_secret_key = os.environ.get("MINIO_SECRET_KEY", "")
        self.minio_bucket = os.environ.get("MINIO_BUCKET", "yolo-artifacts")
        self.minio_secure = os.environ.get("MINIO_SECURE", "false").lower() == "true"

        # Ultralytics device: 'cpu' or a GPU index like '0'.
        self.device = os.environ.get("TRAINING_DEVICE", "cpu")

        # How often (seconds) to refresh job_executions.heartbeat_at during long work.
        self.heartbeat_interval_s = int(os.environ.get("WORKER_HEARTBEAT_INTERVAL_S", "20"))

    def pg_conninfo(self) -> str:
        return (
            f"host={self.pg_host} port={self.pg_port} dbname={self.pg_db} "
            f"user={self.pg_user} password={self.pg_password} "
            f"options='-c search_path=app,public'"
        )
