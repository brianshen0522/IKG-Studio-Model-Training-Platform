"""Model Root scan.

Walks the Model Root of every dataset type and registers each `.pt` it finds, reading
the metadata straight out of the Ultralytics checkpoint rather than asking the user to
describe the file. Replaces manual model import: a file dropped into the root shows up
after the next scan.

What each checkpoint yields:
  train_args.imgsz    the image size the model was trained at  (the number that decides
                      whether a model is comparable to another)
  train_args.task     detect / obb / segment / pose / classify
  train_args.model    the weights it started from, e.g. .../yolov8n.pt
  version             the Ultralytics version that wrote it
  model.names         class count
Version and size letter are read off the architecture name (yolov8n -> v8, n).
"""
import hashlib
import json
import os
import re
import uuid

from . import log

# yolov8n / yolo11s / yolo12x, optionally with a task suffix (-obb, -seg, ...).
_ARCH_RE = re.compile(r"yolo(?:v)?(\d+)([nsmlx])(?:-(obb|seg|pose|cls))?", re.IGNORECASE)

_TASK_FROM_SUFFIX = {"obb": "OBB", "seg": "SEGMENT", "pose": "POSE", "cls": "CLASSIFY"}
def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


_TASK_FROM_ULTRALYTICS = {
    "detect": "DETECT", "obb": "OBB", "segment": "SEGMENT",
    "pose": "POSE", "classify": "CLASSIFY",
}


def _parse_arch(name: str) -> dict:
    """Pull the YOLO generation, size letter and task suffix out of a weights name."""
    m = _ARCH_RE.search(os.path.basename(name or ""))
    if not m:
        return {}
    gen, size, suffix = m.group(1), m.group(2).lower(), (m.group(3) or "").lower()
    return {
        "yolo_version": f"v{gen}",
        "yolo_size": size,
        "task_from_name": _TASK_FROM_SUFFIX.get(suffix, "DETECT"),
    }


def _as_arg_dict(args) -> dict:
    """Ultralytics stores training config as a dict on some checkpoints and as an
    IterableSimpleNamespace on others. Anything else yields nothing."""
    if isinstance(args, dict):
        return args
    ns = getattr(args, "__dict__", None)
    return ns if isinstance(ns, dict) else {}


def read_checkpoint_metadata(path: str) -> dict:
    """Best-effort metadata for one .pt. Never raises — an unreadable file is reported
    with an `error` key so the scan can carry on and the row still shows up."""
    try:
        import torch
    except Exception as e:  # noqa: BLE001
        return {"error": f"torch unavailable: {e}"}

    try:
        ck = torch.load(path, map_location="cpu", weights_only=False)
    except Exception as e:  # noqa: BLE001
        return {"error": f"unreadable checkpoint: {str(e)[:160]}"}

    model_obj = ck.get("model")
    names = getattr(model_obj, "names", None) or {}
    # `train_args` is written by Ultralytics' own trainer when it saves a checkpoint, but
    # plenty of published weights are re-saved without it and carry the same config on the
    # model object instead (`model.args`). Reading only the top-level key left those files
    # with no imgsz, epochs or base weights at all. Prefer train_args where both exist —
    # it is the record of the run that produced *this* file.
    train_args = {**_as_arg_dict(getattr(model_obj, "args", None)),
                  **_as_arg_dict(getattr(ck.get("ema"), "args", None)),
                  **_as_arg_dict(ck.get("train_args"))}

    # The architecture is most reliably named by the weights the run started from;
    # fall back to this file's own name for weights that were never fine-tuned.
    arch = _parse_arch(str(train_args.get("model") or "")) or _parse_arch(path)

    task = _TASK_FROM_ULTRALYTICS.get(str(train_args.get("task") or "").lower())
    if not task:
        task = arch.get("task_from_name") or "DETECT"

    meta = {
        "framework": "pytorch",
        "model_family": "ultralytics",
        "task": task,
        "imgsz": train_args.get("imgsz"),
        "epochs": train_args.get("epochs"),
        "batch": train_args.get("batch"),
        "base_weights": os.path.basename(str(train_args.get("model") or "")) or None,
        "ultralytics_version": ck.get("version"),
        "trained_at": ck.get("date"),
        "class_count": len(names) if names else None,
        "yolo_version": arch.get("yolo_version"),
        "yolo_size": arch.get("yolo_size"),
    }
    return {k: v for k, v in meta.items() if v is not None}


class ModelScanner:
    """Registers every .pt under each dataset type's model_path."""

    def __init__(self, conn, cfg) -> None:
        self.conn = conn
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        correlation_id = payload.get("correlation_id")
        requested_type = payload.get("dataset_type_id")
        log.info("model scan dispatched", dataset_type_id=requested_type, correlation_id=correlation_id)

        # Always read every root, even for a single-type scan: a root nested inside the
        # one being scanned has to be skipped whether or not its type is in scope.
        with self.conn.cursor() as cur:
            cur.execute("SELECT id, name, model_path FROM dataset_types WHERE model_path IS NOT NULL")
            all_types = cur.fetchall()
        all_roots = [t[2] for t in all_types]
        types = [t for t in all_types if str(t[0]) == str(requested_type)] if requested_type else all_types

        tally = {"types": len(types), "found": 0, "registered": 0,
                 "backfilled": 0, "skipped": 0, "roots_missing": 0, "delegated": 0}
        for type_id, type_name, model_root in types:
            self._scan_one(type_id, type_name, model_root, all_roots, correlation_id, tally)

        log.info("model scan completed", **tally)
        # The dispatch is fire-and-forget over the outbox, so the browser has no way to
        # learn the outcome from the 202 alone. This row is what the API polls to turn
        # "dispatched" into "found N, registered M".
        self._record_completion(requested_type, correlation_id, tally)

    def _record_completion(self, requested_type, correlation_id, tally: dict) -> None:
        resource_id = requested_type or correlation_id
        if not resource_id:
            return
        try:
            with self.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, "
                    "resource_id, result, correlation_id, metadata) "
                    "VALUES ('WORKER',%s,'MODEL_SCAN_COMPLETED','MODEL',%s,'SUCCESS',%s,%s)",
                    (self.cfg.consumer, resource_id, correlation_id, json.dumps(tally)),
                )
            self.conn.commit()
        except Exception as e:  # noqa: BLE001
            # A scan that did its work must not be reported as failed just because the
            # receipt could not be written.
            self.conn.rollback()
            log.warn("could not record scan completion", error=str(e)[:160])

    @staticmethod
    def _delegated_roots(model_root: str, all_roots) -> set:
        """Other types' Model Roots that live *inside* this one.

        Roots are allowed to nest (a type can sit under a shared parent directory), and
        without this every ancestor would also claim its descendants' checkpoints — the
        same file ending up registered once per enclosing type. The deepest root owns a
        file: the walk stops at these directories and lets that type register them.
        Equal paths are not delegated, since neither is more specific.
        """
        base = os.path.normpath(model_root)
        return {
            os.path.normpath(r) for r in all_roots
            if os.path.normpath(r) != base and os.path.normpath(r).startswith(base + os.sep)
        }

    def _scan_one(self, type_id, type_name: str, model_root: str, all_roots,
                  correlation_id, tally: dict) -> None:
        if not os.path.isdir(model_root):
            log.warn("model root missing", dataset_type=type_name, model_root=model_root)
            tally["roots_missing"] += 1
            return

        delegated = self._delegated_roots(model_root, all_roots)
        if delegated:
            log.info("model root has nested roots, delegating those subtrees",
                     dataset_type=type_name, nested=sorted(delegated))

        with self.conn.cursor() as cur:
            # Archived rows count as known: a model the user archived must not be
            # resurrected under a fresh id just because the file is still on disk.
            cur.execute(
                "SELECT relative_path, id, architecture_metadata, archived_at FROM models "
                "WHERE dataset_type_id=%s",
                (type_id,),
            )
            known = {r[0]: (r[1], r[2], r[3]) for r in cur.fetchall()}

        for dirpath, dirnames, filenames in os.walk(model_root):
            keep = []
            for d in dirnames:
                if d.startswith("."):
                    continue
                if os.path.normpath(os.path.join(dirpath, d)) in delegated:
                    tally["delegated"] += 1
                    continue
                keep.append(d)
            dirnames[:] = keep
            for fn in sorted(filenames):
                if not fn.endswith(".pt"):
                    continue
                full = os.path.join(dirpath, fn)
                if os.path.islink(full):
                    continue
                rel = os.path.relpath(full, model_root)
                tally["found"] += 1
                if rel in known:
                    model_id, existing_meta, archived_at = known[rel]
                    if archived_at is not None:
                        continue
                    # Already registered, but its metadata may predate this extractor —
                    # anything the trainer registered before it read checkpoints back got
                    # only framework/family/task. Re-reading here makes a rescan the
                    # repair path instead of forcing a delete-and-rediscover.
                    if self._repair(model_id, existing_meta, rel, full, correlation_id):
                        tally["backfilled"] += 1
                    continue
                if self._register(type_id, model_root, rel, full, fn, correlation_id):
                    tally["registered"] += 1
                else:
                    # Unreadable or rejected by the DB. Counted so a file that never shows
                    # up in the list is reported instead of silently vanishing.
                    tally["skipped"] += 1

    # Fields that make a model comparable to others; if any is absent the row predates
    # checkpoint-based extraction and is worth re-reading.
    _RICH_KEYS = ("imgsz", "class_count", "yolo_version", "base_weights")

    def _repair(self, model_id, existing: dict | None, rel: str, full: str, correlation_id) -> bool:
        existing = existing or {}
        if all(existing.get(k) is not None for k in self._RICH_KEYS):
            return False
        meta = read_checkpoint_metadata(full)
        if "error" in meta:
            return False
        # Only rewrite if the checkpoint actually yields something new, so a genuinely
        # metadata-poor file is not rewritten on every scan.
        gained = [k for k in self._RICH_KEYS if existing.get(k) is None and meta.get(k) is not None]
        if not gained:
            return False
        merged = {**existing, **meta}
        try:
            with self.conn.cursor() as cur:
                cur.execute(
                    "UPDATE models SET architecture_metadata=%s, task_type=%s WHERE id=%s",
                    (json.dumps(merged), merged.get("task", "DETECT"), model_id),
                )
                cur.execute(
                    "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, "
                    "resource_id, result, correlation_id, metadata) "
                    "VALUES ('WORKER',%s,'MODEL_METADATA_BACKFILLED','MODEL',%s,'SUCCESS',%s,%s)",
                    (self.cfg.consumer, model_id, correlation_id,
                     json.dumps({"relative_path": rel, "gained": gained})),
                )
            self.conn.commit()
            log.info("model metadata backfilled", path=rel, gained=gained,
                     imgsz=merged.get("imgsz"), classes=merged.get("class_count"))
            return True
        except Exception as e:  # noqa: BLE001
            self.conn.rollback()
            log.warn("could not backfill model metadata", path=rel, error=str(e)[:160])
            return False

    def _register(self, type_id, model_root: str, rel: str, full: str, filename: str, correlation_id) -> bool:
        meta = read_checkpoint_metadata(full)
        if "error" in meta:
            log.warn("skipping unreadable model", path=rel, error=meta["error"])
            return False

        try:
            size_bytes = os.path.getsize(full)
            checksum = _sha256(full)
        except OSError:
            return False

        model_id = str(uuid.uuid4())
        name = os.path.splitext(os.path.basename(filename))[0]
        try:
            with self.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO models (id, name, dataset_type_id, task_type, source_type, status, "
                    "relative_path, original_filename, file_size_bytes, checksum_algorithm, checksum, "
                    "architecture_metadata, model_path, available_at) "
                    "VALUES (%s,%s,%s,%s,'UPLOAD','AVAILABLE',%s,%s,%s,'SHA256',%s,%s,%s,now())",
                    (model_id, name, type_id, meta.get("task", "DETECT"), rel, filename,
                     size_bytes, checksum, json.dumps(meta), full),
                )
                cur.execute(
                    "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, "
                    "resource_id, result, correlation_id, metadata) "
                    "VALUES ('WORKER',%s,'MODEL_DISCOVERED','MODEL',%s,'SUCCESS',%s,%s)",
                    (self.cfg.consumer, model_id, correlation_id, json.dumps({"relative_path": rel})),
                )
            self.conn.commit()
            log.info("model registered from scan", name=name, path=rel,
                     imgsz=meta.get("imgsz"), task=meta.get("task"))
            return True
        except Exception as e:  # noqa: BLE001
            self.conn.rollback()
            log.warn("could not register model", path=rel, error=str(e)[:160])
            return False
