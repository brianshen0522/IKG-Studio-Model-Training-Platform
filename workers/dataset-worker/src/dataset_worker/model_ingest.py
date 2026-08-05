"""Model ingest (doc 07 §14-20): URL_DOWNLOAD / UPLOAD into the global Model Root.

Downloads (or reads an uploaded temp object), runs Level-1 binary validation plus a
light Level-2 archive inspection (no torch in this worker), then copies the file into
the Model Root via staging + atomic rename and registers an AVAILABLE model.
"""
import hashlib
import ipaddress
import os
import re
import shutil
import socket
import urllib.request
import uuid
import zipfile
from urllib.parse import urljoin, urlparse

from . import joblog, log

INGEST_EVENT = "job.model_ingest.dispatch"
MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024 * 1024   # 5 GiB hard ceiling
MAX_REDIRECTS = 5
DOWNLOAD_TIMEOUT_S = 300
_METADATA_IPS = {"169.254.169.254"}


class IngestError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _sanitize(name: str) -> str:
    slug = re.sub(r"\s+", "-", name.strip())
    slug = re.sub(r"[^A-Za-z0-9._-]", "", slug)
    slug = slug.strip("-._")
    return slug or "model"


def _assert_public_host(host: str, allow_private: bool) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise IngestError("MODEL_DOWNLOAD_FAILED", f"DNS resolution failed: {e}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        # The metadata service is always blocked, even when private networks are permitted.
        if str(ip) in _METADATA_IPS:
            raise IngestError("MODEL_URL_SCHEME_NOT_ALLOWED", f"blocked metadata address: {ip}")
        if allow_private:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
                or ip.is_reserved or ip.is_unspecified):
            raise IngestError("MODEL_URL_SCHEME_NOT_ALLOWED", f"blocked non-public address: {ip}")


def _open_url(url: str, allow_http: bool, allow_private: bool):
    """Manual redirect handling so every hop is SSRF-revalidated."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        parsed = urlparse(current)
        if parsed.scheme not in ("http", "https"):
            raise IngestError("MODEL_URL_SCHEME_NOT_ALLOWED", f"scheme not allowed: {parsed.scheme}")
        if parsed.scheme == "http" and not allow_http:
            raise IngestError("MODEL_URL_SCHEME_NOT_ALLOWED", "http:// disabled")
        if not parsed.hostname:
            raise IngestError("MODEL_INVALID_URL", "missing host")
        _assert_public_host(parsed.hostname, allow_private)
        req = urllib.request.Request(current, headers={"User-Agent": "model-trainer-model-ingest"})
        opener = urllib.request.build_opener(_NoRedirect())
        resp = opener.open(req, timeout=DOWNLOAD_TIMEOUT_S)
        if resp.status in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location")
            resp.close()
            if not loc:
                raise IngestError("MODEL_DOWNLOAD_FAILED", "redirect without Location")
            current = urljoin(current, loc)
            continue
        if resp.status != 200:
            resp.close()
            raise IngestError("MODEL_DOWNLOAD_FAILED", f"unexpected status {resp.status}")
        return resp
    raise IngestError("MODEL_DOWNLOAD_FAILED", "too many redirects")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def _validate_file(path: str, min_size: int, expected_checksum: str | None) -> dict:
    size = os.path.getsize(path)
    if size < min_size:
        raise IngestError("MODEL_FILE_TOO_SMALL", f"file size {size} < minimum {min_size}")
    h = hashlib.sha256()
    with open(path, "rb") as f:
        head = f.read(4)
        f.seek(0)
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    checksum = h.hexdigest()
    if expected_checksum and checksum.lower() != expected_checksum.lower():
        raise IngestError("MODEL_CHECKSUM_MISMATCH", "actual checksum does not match expected")

    # Level 2 (light): PyTorch .pt since 1.6 is a zip; legacy is a pickle stream (0x80).
    arch = {"framework": "pytorch"}
    if head[:2] == b"PK":
        try:
            with zipfile.ZipFile(path) as zf:
                names = zf.namelist()
            arch["archive"] = "zip"
            arch["entry_count"] = len(names)
            arch["is_torch_archive"] = any(n.endswith("data.pkl") or "/data/" in n or n.endswith("/version") for n in names)
        except zipfile.BadZipFile:
            raise IngestError("MODEL_INVALID_FILE", "declared zip archive is corrupt")
    elif head[:1] == b"\x80":
        arch["archive"] = "pickle"
        arch["is_torch_archive"] = True
    else:
        raise IngestError("MODEL_INVALID_FILE", "not a recognised PyTorch .pt (bad magic bytes)")

    return {"size": size, "checksum": checksum, "architecture": arch,
            "validation": {"level1": True, "level2_light": True, "magic": head.hex()}}


class ModelIngestWorker:
    def __init__(self, conn, storage, cfg) -> None:
        self.conn = conn
        self.storage = storage
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        task_id = payload["model_ingest_task_id"]
        job_execution_id = payload["job_execution_id"]
        assignment_token = payload["assignment_token"]
        correlation_id = payload.get("correlation_id")
        log.info("model ingest dispatched", model_ingest_task_id=task_id, job_execution_id=job_execution_id)

        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE job_executions SET status='CLAIMED', claimed_at=now() "
                "WHERE id=%s AND assignment_token=%s AND status='ASSIGNED' RETURNING id",
                (job_execution_id, assignment_token),
            )
            if cur.fetchone() is None:
                log.warn("ingest execution not claimable", job_execution_id=job_execution_id)
                return
            cur.execute("UPDATE job_executions SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=%s", (job_execution_id,))
            cur.execute("UPDATE model_ingest_tasks SET status='VALIDATING', started_at=now() WHERE id=%s", (task_id,))
        self.conn.commit()

        ctx = self._load(task_id)
        staging_dir = os.path.join(ctx["root_host"], ".ingest", task_id)
        tmp_file = os.path.join(staging_dir, "download.bin")
        with joblog.Capture(self.storage, self.cfg.pg_conninfo(), self.cfg.consumer, job_execution_id):
            try:
                os.makedirs(staging_dir, exist_ok=True)
                joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 10, "Fetching model file")
                self._fetch(ctx, tmp_file)
                info = _validate_file(tmp_file, ctx["min_size"], ctx["expected_checksum"])
                joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 60,
                                f"Downloaded {info['size']} bytes, checksum verified")
                self._publish_and_register(ctx, task_id, job_execution_id, correlation_id, tmp_file, info)
                joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 100, "Model published and registered")
            except IngestError as ie:
                shutil.rmtree(staging_dir, ignore_errors=True)
                self._fail(ctx, task_id, job_execution_id, correlation_id, ie.code, ie.message)
            except Exception as e:  # noqa: BLE001
                shutil.rmtree(staging_dir, ignore_errors=True)
                self._fail(ctx, task_id, job_execution_id, correlation_id, "MODEL_INGEST_FAILED", str(e)[:500])
            finally:
                self._cleanup_temp_object(ctx)

    def _load(self, task_id: str) -> dict:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT t.source_type, t.requested_name, t.requested_version_label, t.requested_description, "
                "t.dataset_type_id, t.task_type, t.original_filename, t.source_url, t.expected_checksum, "
                "t.temporary_object_key, t.created_by_user_id, "
                "dt.model_path "
                "FROM model_ingest_tasks t "
                "JOIN dataset_types dt ON dt.id=t.dataset_type_id "
                "WHERE t.id=%s",
                (task_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise IngestError("MODEL_ROOT_NOT_FOUND", "ingest task or MODEL root not found")
            (source_type, name, version_label, description, dataset_type_id, task_type, original_filename,
             source_url, expected_checksum, temp_key, created_by, root_host) = row

            if not root_host:
                raise IngestError("MODEL_ROOT_NOT_FOUND", "dataset type has no model_path configured")

            cur.execute("SELECT value FROM system_settings WHERE setting_key='model_download_allow_http'")
            r = cur.fetchone()
            allow_http = bool(r and r[0] is True)
            cur.execute("SELECT value FROM system_settings WHERE setting_key='model_download_allow_private'")
            r = cur.fetchone()
            allow_private = bool(r and r[0] is True)
            cur.execute("SELECT value FROM system_settings WHERE setting_key='model_min_size_bytes'")
            r = cur.fetchone()
            min_size = int(r[0]) if r and r[0] is not None else 1024
        return {
            "source_type": source_type, "name": name, "version_label": version_label,
            "description": description, "dataset_type_id": str(dataset_type_id), "task_type": task_type,
            "original_filename": original_filename, "source_url": source_url,
            "expected_checksum": expected_checksum, "temp_key": temp_key, "created_by": created_by,
            "root_host": root_host,
            "allow_http": allow_http, "allow_private": allow_private, "min_size": min_size,
        }

    def _fetch(self, ctx: dict, dest: str) -> None:
        if ctx["source_type"] == "URL_DOWNLOAD":
            resp = _open_url(ctx["source_url"], ctx["allow_http"], ctx["allow_private"])
            declared = resp.headers.get("Content-Length")
            if declared and int(declared) > MAX_DOWNLOAD_BYTES:
                resp.close()
                raise IngestError("MODEL_DOWNLOAD_FAILED", "Content-Length exceeds limit")
            written = 0
            try:
                with open(dest, "wb") as out:
                    for chunk in iter(lambda: resp.read(1024 * 1024), b""):
                        written += len(chunk)
                        if written > MAX_DOWNLOAD_BYTES:
                            raise IngestError("MODEL_DOWNLOAD_FAILED", "download exceeded size limit")
                        out.write(chunk)
            finally:
                resp.close()
        elif ctx["source_type"] == "UPLOAD":
            if not ctx["temp_key"]:
                raise IngestError("MODEL_UPLOAD_INVALID", "missing temporary_object_key")
            data = self.storage.get_bytes(ctx["temp_key"])
            with open(dest, "wb") as out:
                out.write(data)
        else:
            raise IngestError("MODEL_INGEST_FAILED", f"unsupported source_type {ctx['source_type']}")

    def _target_relative_path(self, ctx: dict, checksum: str) -> str:
        sub = "downloaded" if ctx["source_type"] == "URL_DOWNLOAD" else "uploaded"
        parts = [_sanitize(ctx["name"])]
        if ctx["version_label"]:
            parts.append(_sanitize(ctx["version_label"]))
        parts.append(checksum[:6])
        filename = "_".join(parts) + ".pt"
        rel = f"registry/{sub}/{filename}"
        # Collision guard against a different existing file.
        if os.path.exists(os.path.join(ctx["root_host"], rel)):
            filename = "_".join(parts + [uuid.uuid4().hex[:6]]) + ".pt"
            rel = f"registry/{sub}/{filename}"
        return rel

    def _publish_and_register(self, ctx, task_id, job_execution_id, correlation_id, tmp_file, info) -> None:
        rel = self._target_relative_path(ctx, info["checksum"])
        target_final = os.path.join(ctx["root_host"], rel)
        os.makedirs(os.path.dirname(target_final), exist_ok=True)
        staging_target = target_final + f".staging-{uuid.uuid4().hex[:8]}"
        shutil.copy2(tmp_file, staging_target)
        if os.path.getsize(staging_target) != info["size"]:
            os.remove(staging_target)
            raise IngestError("MODEL_INGEST_FAILED", "staged size mismatch")
        if os.path.exists(target_final):
            os.remove(staging_target)
            raise IngestError("MODEL_INGEST_FAILED", "target path already exists")
        os.rename(staging_target, target_final)

        model_id = str(uuid.uuid4())
        with self.conn.cursor() as cur:
            model_full_path = os.path.join(ctx["root_host"], rel)
            cur.execute(
                "INSERT INTO models (id, name, version_label, description, dataset_type_id, task_type, "
                "source_type, status, relative_path, model_path, original_filename, file_size_bytes, "
                "checksum_algorithm, checksum, source_url, architecture_metadata, validation_summary, "
                "available_at, created_by_user_id) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,'AVAILABLE',%s,%s,%s,%s,'SHA-256',%s,%s,%s,%s,now(),%s)",
                (model_id, ctx["name"], ctx["version_label"], ctx["description"], ctx["dataset_type_id"],
                 ctx["task_type"], ctx["source_type"], rel, model_full_path,
                 ctx["original_filename"] or os.path.basename(rel), info["size"], info["checksum"],
                 ctx["source_url"], _json(info["architecture"]), _json(info["validation"]), ctx["created_by"]),
            )
            cur.execute(
                "UPDATE model_ingest_tasks SET status='COMPLETED', progress_percent=100, finished_at=now(), "
                "result_model_id=%s WHERE id=%s",
                (model_id, task_id),
            )
            cur.execute(
                "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                "result, correlation_id, metadata) VALUES ('WORKER',%s,'MODEL_CREATED','MODEL',%s,'SUCCESS',%s,%s) RETURNING id",
                (self.cfg.consumer, model_id, correlation_id,
                 _json({"source_type": ctx["source_type"], "checksum": info["checksum"], "size": info["size"]})),
            )
            audit_id = cur.fetchone()[0]
            if ctx["created_by"]:
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'SUCCESS','Model Registered',%s,'MODEL',%s)",
                    (audit_id, ctx["created_by"], f"Model \"{ctx['name']}\" is now available.", model_id),
                )
            cur.execute("UPDATE job_executions SET status='SUCCEEDED', finished_at=now() WHERE id=%s", (job_execution_id,))
        self.conn.commit()
        log.info("model ingest completed", model_id=model_id, relative_path=rel, checksum=info["checksum"][:12])

    def _fail(self, ctx, task_id, job_execution_id, correlation_id, code, message) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE model_ingest_tasks SET status='FAILED', finished_at=now(), failure_code=%s, failure_message=%s WHERE id=%s",
                (code, message[:1000], task_id),
            )
            cur.execute(
                "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                "result, correlation_id, error_code, error_message) VALUES ('WORKER',%s,'MODEL_INGEST_FAILED',"
                "'MODEL_INGEST',%s,'FAILURE',%s,%s,%s) RETURNING id",
                (self.cfg.consumer, task_id, correlation_id, code, message[:1000]),
            )
            audit_id = cur.fetchone()[0]
            if ctx and ctx.get("created_by"):
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'ERROR','Model Ingest Failed',%s,'MODEL_INGEST',%s)",
                    (audit_id, ctx["created_by"], f"Model \"{ctx.get('name','?')}\" ingest failed: {code}.", task_id),
                )
            cur.execute("UPDATE job_executions SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                        (code, message[:1000], job_execution_id))
        self.conn.commit()
        log.error("model ingest failed", model_ingest_task_id=task_id, error_code=code, detail=message[:200])

    def _cleanup_temp_object(self, ctx) -> None:
        if ctx and ctx.get("source_type") == "UPLOAD" and ctx.get("temp_key"):
            try:
                self.storage.client.remove_object(self.storage.bucket, ctx["temp_key"])
            except Exception:  # noqa: BLE001
                pass


def _json(obj) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False)
