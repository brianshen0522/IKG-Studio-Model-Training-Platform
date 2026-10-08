"""Copy and verify every object from the old SeaweedFS into RustFS.

Run by migrate-seaweedfs-to-rustfs.sh inside the training-worker image, so the
transfer uses the same minio SDK version the platform itself uses.

The source is only ever listed, statted and read (AGENTS.md rule 3: artifacts
are immutable — a migration may copy them but must never alter them).

Verification is per object and by content, not by count:
  key present -> size equal -> SHA-256 of the bytes read back through RustFS.
A copy that cannot be read back through the target is a failure, because that
is exactly what the application will do with it. The result is then reconciled
against app.artifacts, which is the authority on what must exist.
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
        secure=False,
        # SeaweedFS answers GetBucketLocation with no region; see
        # apps/api/src/storage/object-store.service.ts.
        region="us-east-1",
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


def digest(c: Minio, bucket: str, key: str) -> tuple[str, int] | None:
    try:
        return digest_stream(c.get_object(bucket, key))
    except S3Error as exc:
        if exc.code in ("NoSuchKey", "NoSuchBucket"):
            return None
        raise


def load_expected(path: str | None) -> dict[tuple[str, str], str] | None:
    """(bucket, key) -> SHA-256 from app.artifacts, dumped by the wrapper as TSV."""
    if not path or not os.path.exists(path):
        return None
    expected: dict[tuple[str, str], str] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 3 and parts[0] and parts[1]:
                expected[(parts[0], parts[1])] = parts[2].lower()
    return expected


def main() -> int:
    mode = env("MODE", "copy")
    src = client("SRC")
    dst = client("DST")

    buckets = sorted(b.name for b in src.list_buckets())
    print(f"migrate: source buckets: {', '.join(buckets) or '(none)'}  (mode={mode})")

    failures: list[str] = []
    copied = skipped = 0
    # (bucket, key) -> SHA-256 of what the target now serves.
    target: dict[tuple[str, str], str] = {}

    for bucket in buckets:
        dst_has_bucket = dst.bucket_exists(bucket)
        if mode == "copy" and not dst_has_bucket:
            dst.make_bucket(bucket)
            dst_has_bucket = True

        objects = [
            o
            for o in src.list_objects(bucket, recursive=True)
            if not o.is_dir and o.object_name is not None
        ]
        total_bytes = sum(o.size or 0 for o in objects)
        print(f"migrate: {bucket}: {len(objects)} objects, {total_bytes / 1024 / 1024:.1f} MiB")

        for index, obj in enumerate(objects, start=1):
            key = cast(str, obj.object_name)
            try:
                src_sum = digest(src, bucket, key)
                if src_sum is None:
                    # Listed a moment ago and gone now: something is still writing.
                    failures.append(f"{bucket}/{key}: vanished from source during the run")
                    continue

                existing = digest(dst, bucket, key) if dst_has_bucket else None
                if existing == src_sum:
                    skipped += 1
                    target[(bucket, key)] = existing[0]
                    continue

                if mode in ("verify", "dryrun"):
                    reason = "missing" if existing is None else "checksum/size mismatch"
                    if mode == "dryrun":
                        print(f"  would copy {bucket}/{key} ({reason})")
                    else:
                        failures.append(f"{bucket}/{key}: {reason}")
                    continue

                response = src.get_object(bucket, key)
                try:
                    content_type = (
                        src.stat_object(bucket, key).content_type or "application/octet-stream"
                    )
                    # urllib3's response is a readable stream, which is all
                    # put_object uses; the cast keeps the transfer streaming.
                    dst.put_object(
                        bucket,
                        key,
                        cast(BinaryIO, response),
                        length=src_sum[1],
                        part_size=PART_SIZE,
                        content_type=content_type,
                    )
                finally:
                    response.close()
                    response.release_conn()

                # Read it back through the target: the only proof that matters.
                written = digest(dst, bucket, key)
                if written != src_sum:
                    failures.append(f"{bucket}/{key}: wrote but read back {written}")
                    continue
                target[(bucket, key)] = written[0]
                copied += 1
                if copied % 50 == 0 or index == len(objects):
                    print(f"  [{index}/{len(objects)}] copied={copied} skipped={skipped}")
            except Exception as exc:  # noqa: BLE001 - report and continue; summary decides exit
                failures.append(f"{bucket}/{key}: {type(exc).__name__}: {exc}")

    if mode == "dryrun":
        return 0

    print(f"migrate: copied={copied} already-present={skipped} failed={len(failures)}")
    if failures:
        print("migrate: failures:", file=sys.stderr)
        for line in failures[:20]:
            print(f"  - {line}", file=sys.stderr)
        if len(failures) > 20:
            print(f"  … and {len(failures) - 20} more", file=sys.stderr)
        return 1

    print(f"migrate: verified {len(target)} objects byte-for-byte on the target.")

    # Two stores agreeing with each other only proves the copy was faithful. The
    # database says which artifacts must exist, so a row whose object is absent
    # on the target is a broken artifact, and that is what this catches.
    expected = load_expected(os.environ.get("EXPECTED_KEYS_FILE"))
    if expected is None:
        print("migrate: no database key list supplied; DB reconciliation skipped", file=sys.stderr)
        return 0

    missing = sorted(k for k in expected if k not in target)
    if missing:
        print(f"migrate: {len(missing)} artifact rows have no object on the target", file=sys.stderr)
        for bucket, key in missing[:20]:
            print(f"  - {bucket}/{key}", file=sys.stderr)
        return 1

    # Not fatal: the target matches the source byte for byte, so a checksum that
    # disagrees with the row already disagreed before the migration. Reported so
    # it is not mistaken for something this run did.
    differing = [k for k, want in expected.items() if want and target[k] != want]
    if differing:
        print(
            f"migrate: note: {len(differing)} objects differ from app.artifacts.checksum "
            "in the source too (pre-existing, not caused by this copy)"
        )
        for bucket, key in differing[:20]:
            print(f"  - {bucket}/{key}")

    # Objects with no row are not fatal either: an interrupted upload can leave
    # one behind, and deleting data is not this script's job.
    orphans = len(target) - len(expected)
    if orphans > 0:
        print(f"migrate: note: {orphans} objects on the target have no artifact row")

    print(f"migrate: reconciled {len(expected)} artifact rows against the target.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
