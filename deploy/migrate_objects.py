"""Copy and verify every object from MinIO into SeaweedFS.

Run by migrate-minio-to-seaweedfs.sh inside the training-worker image, so the transfer
uses the same minio SDK version the platform itself uses.

The source is opened read-only in spirit and in practice: only list/stat/get are ever
called against it (AGENTS.md rule 2 on read-only sources, and rule 3 on artifacts being
immutable — a migration may copy them but must never alter them).

Verification is per object and by content, not by count:
  key present  ->  size equal  ->  SHA-256 of the bytes read back through the new server.
A copy that cannot be read back through the target is a failure, because that is exactly
what the application will do with it.
"""

import hashlib
import os
import sys
from typing import BinaryIO, cast

from minio import Minio
from minio.error import S3Error

CHUNK = 8 * 1024 * 1024
PART_SIZE = 16 * 1024 * 1024


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise SystemExit(f"migrate: {name} is required")
    return value


def client(prefix: str) -> Minio:
    return Minio(
        env(f"{prefix}_ENDPOINT"),
        access_key=env(f"{prefix}_ACCESS_KEY"),
        secret_key=env(f"{prefix}_SECRET_KEY"),
        secure=os.environ.get(f"{prefix}_SECURE", "false").lower() == "true",
    )


def digest_stream(response) -> tuple[str, int]:
    """SHA-256 and byte count, streamed so a multi-GB artifact never lands in memory."""
    h = hashlib.sha256()
    total = 0
    try:
        while True:
            chunk = response.read(CHUNK)
            if not chunk:
                break
            h.update(chunk)
            total += len(chunk)
    finally:
        response.close()
        response.release_conn()
    return h.hexdigest(), total


def source_digest(src: Minio, bucket: str, key: str) -> tuple[str, int]:
    return digest_stream(src.get_object(bucket, key))


def target_digest(dst: Minio, bucket: str, key: str) -> tuple[str, int] | None:
    try:
        return digest_stream(dst.get_object(bucket, key))
    except S3Error as exc:
        if exc.code in ("NoSuchKey", "NoSuchBucket"):
            return None
        raise


def main() -> int:
    mode = env("MODE", "copy")
    bucket = env("SRC_BUCKET", "artifacts")
    src = client("SRC")
    dst = client("DST")

    if not src.bucket_exists(bucket):
        print(f"migrate: source bucket {bucket!r} does not exist", file=sys.stderr)
        return 1

    # The bucket is created by the wrapper through SeaweedFS's filer, not here:
    # CreateBucket over S3 demands the global "Admin" action, which these credentials
    # deliberately do not have. Fail loudly rather than silently writing nowhere.
    if mode != "dryrun" and not dst.bucket_exists(bucket):
        print(f"migrate: target bucket {bucket!r} does not exist", file=sys.stderr)
        return 1

    objects = [o for o in src.list_objects(bucket, recursive=True) if not o.is_dir]
    total_bytes = sum(o.size or 0 for o in objects)
    print(f"migrate: {len(objects)} objects, {total_bytes / 1024 / 1024:.1f} MiB  (mode={mode})")

    copied = skipped = failed = 0
    failures: list[str] = []

    for index, obj in enumerate(objects, start=1):
        # The SDK calls this object_name; there is no .key attribute on Object.
        key = obj.object_name
        if key is None:
            continue
        try:
            src_sum, src_size = source_digest(src, bucket, key)

            if mode == "dryrun":
                existing = target_digest(dst, bucket, key)
                state = "present" if existing and existing[0] == src_sum else "would copy"
                print(f"  [{index}/{len(objects)}] {state}: {key} ({src_size} bytes)")
                continue

            existing = target_digest(dst, bucket, key)
            if existing is not None and existing == (src_sum, src_size):
                skipped += 1
                continue

            if mode == "verify":
                failed += 1
                reason = "missing" if existing is None else "checksum/size mismatch"
                failures.append(f"{key}: {reason}")
                print(f"  MISSING {key}: {reason}", file=sys.stderr)
                continue

            # Stream the source object straight into the target; never buffer whole.
            response = src.get_object(bucket, key)
            try:
                content_type = (
                    src.stat_object(bucket, key).content_type or "application/octet-stream"
                )
                # urllib3's response is a readable stream, which is all put_object uses,
                # but it is not a typing.BinaryIO. Wrapping keeps the transfer streaming
                # (no whole-object buffering) while giving the SDK the shape it declares.
                dst.put_object(
                    bucket,
                    key,
                    cast(BinaryIO, response),
                    length=src_size,
                    part_size=PART_SIZE,
                    content_type=content_type,
                )
            finally:
                response.close()
                response.release_conn()

            # Read it back through the target: the only proof that matters.
            written = target_digest(dst, bucket, key)
            if written != (src_sum, src_size):
                failed += 1
                failures.append(f"{key}: verification failed after copy")
                print(f"  FAILED  {key}: wrote but read back {written}", file=sys.stderr)
                continue

            copied += 1
            if copied % 50 == 0 or index == len(objects):
                print(f"  [{index}/{len(objects)}] copied={copied} skipped={skipped}")

        except Exception as exc:  # noqa: BLE001 - report and continue; summary decides exit
            failed += 1
            failures.append(f"{key}: {type(exc).__name__}: {exc}")
            print(f"  ERROR   {key}: {type(exc).__name__}: {exc}", file=sys.stderr)

    if mode == "dryrun":
        return 0

    print(f"migrate: copied={copied} skipped={skipped} failed={failed}")

    if failed:
        print("migrate: failures:", file=sys.stderr)
        for line in failures[:20]:
            print(f"  - {line}", file=sys.stderr)
        if len(failures) > 20:
            print(f"  … and {len(failures) - 20} more", file=sys.stderr)
        return 1

    # Reconcile against the database, which is the authority on what must exist. An
    # object store that merely agrees with itself proves nothing: a row whose object is
    # absent is a broken artifact, and that is what this catches.
    # object_name is Optional in the SDK's type; a listing entry without a name cannot
    # be reconciled either way, so drop it here rather than carrying None into sorted().
    target_keys = {
        o.object_name
        for o in dst.list_objects(bucket, recursive=True)
        if not o.is_dir and o.object_name is not None
    }
    source_keys = {o.object_name for o in objects if o.object_name is not None}
    only_in_source = source_keys - target_keys
    if only_in_source:
        print(f"migrate: {len(only_in_source)} objects missing on the target", file=sys.stderr)
        for key in sorted(only_in_source)[:20]:
            print(f"  - {key}", file=sys.stderr)
        return 1

    print(f"migrate: verified {len(source_keys)} objects byte-for-byte on the target.")

    # Reconcile against the database, which is the authority on what must exist. Matching
    # the two object stores against each other only proves the copy was faithful; it says
    # nothing about whether every artifact the application believes in is actually there.
    # The expected keys are dumped by the wrapper (which has the psql credentials) into
    # this file, one "bucket_name object_key" pair per line.
    expected_path = os.environ.get("EXPECTED_KEYS_FILE")
    if not expected_path or not os.path.exists(expected_path):
        print("migrate: no database key list supplied; skipped DB reconciliation", file=sys.stderr)
        return 0

    expected: set[str] = set()
    try:
        with open(expected_path, encoding="utf-8") as handle:
            for line in handle:
                row = line.strip()
                if not row:
                    continue
                row_bucket, _, row_key = row.partition(" ")
                if row_bucket == bucket and row_key:
                    expected.add(row_key)
    except OSError as exc:
        # Treat an unreadable list as a failed reconciliation, not a passing run: this is
        # the step that proves no artifact row was left without its object.
        print(f"migrate: cannot read the database key list: {exc}", file=sys.stderr)
        return 1

    missing = expected - target_keys
    if missing:
        print(
            f"migrate: {len(missing)} artifact rows have no object on the target",
            file=sys.stderr,
        )
        for key in sorted(missing)[:20]:
            print(f"  - {key}", file=sys.stderr)
        return 1

    # Objects with no row are reported but not fatal: an interrupted upload can leave one
    # behind, and deleting data is not this script's job.
    orphans = target_keys - expected
    if orphans:
        print(f"migrate: note: {len(orphans)} objects on the target have no artifact row")

    print(f"migrate: reconciled {len(expected)} artifact rows against the target.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
