import os
import socket


def _required(name: str) -> str:
    """Return env var ``name``, or raise if it is unset or empty."""
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"object store is not configured: {name} unset")
    return value

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

        # Credentials and endpoint have no defaults on purpose. They used to
        # fall back to localhost/minioadmin/yolo-artifacts, so a missing or
        # misspelled variable did not fail: the worker started and then talked
        # to the wrong place with the wrong credentials, or wrote artifacts into
        # a bucket nothing else reads. Failing at startup makes that obvious.
        self.s3_endpoint = _required("S3_ENDPOINT")
        self.s3_access_key = _required("S3_ACCESS_KEY")
        self.s3_secret_key = _required("S3_SECRET_KEY")
        self.s3_bucket = _required("S3_BUCKET")
        self.s3_secure = os.environ.get("S3_SECURE", "false").lower() == "true"

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
