import hashlib

from minio import Minio

from .config import Config


class Storage:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.client = Minio(
            cfg.minio_endpoint,
            access_key=cfg.minio_access_key,
            secret_key=cfg.minio_secret_key,
            secure=cfg.minio_secure,
        )
        self.bucket = cfg.minio_bucket

    def ensure_bucket(self) -> None:
        if not self.client.bucket_exists(self.bucket):
            self.client.make_bucket(self.bucket)

    def put_file(self, object_key: str, path: str, content_type: str) -> dict:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        self.client.fput_object(self.bucket, object_key, path, content_type=content_type)
        import os
        return {"bucket": self.bucket, "object_key": object_key,
                "size": os.path.getsize(path), "checksum": h.hexdigest()}

    def get_file(self, bucket: str, object_key: str, path: str) -> None:
        self.client.fget_object(bucket, object_key, path)
