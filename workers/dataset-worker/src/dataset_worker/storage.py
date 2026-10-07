import hashlib
import io

from minio import Minio

from .config import Config


class Storage:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.client = Minio(
            cfg.s3_endpoint,
            access_key=cfg.s3_access_key,
            secret_key=cfg.s3_secret_key,
            secure=cfg.s3_secure,
        )
        self.bucket = cfg.s3_bucket

    def ensure_bucket(self) -> None:
        if not self.client.bucket_exists(self.bucket):
            self.client.make_bucket(self.bucket)

    def get_bytes(self, object_key: str) -> bytes:
        resp = self.client.get_object(self.bucket, object_key)
        try:
            return resp.read()
        finally:
            resp.close()
            resp.release_conn()

    def put_bytes(self, object_key: str, data: bytes, content_type: str) -> dict:
        checksum = hashlib.sha256(data).hexdigest()
        self.client.put_object(
            self.bucket,
            object_key,
            io.BytesIO(data),
            length=len(data),
            content_type=content_type,
        )
        return {
            "bucket": self.bucket,
            "object_key": object_key,
            "size": len(data),
            "checksum": checksum,
        }
