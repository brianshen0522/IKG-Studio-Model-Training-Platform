"""Upload every file a training/benchmark run directory produced.

The worker keeps whatever Ultralytics wrote — named plots map to their chart artifact
type, and anything unrecognised (labels.jpg, train_batch*.jpg, args.yaml, future files)
is kept as TRAINING_OUTPUT. No output is dropped from the artifacts list.
"""
import hashlib
import os
import uuid

_NAME_TYPES = {
    "results.png": ("RESULTS_IMAGE", "image/png"),
    "results.csv": ("RESULTS_CSV", "text/csv"),
    "confusion_matrix.png": ("CONFUSION_MATRIX", "image/png"),
    "confusion_matrix_normalized.png": ("CONFUSION_MATRIX_NORMALIZED", "image/png"),
    "PR_curve.png": ("PR_CURVE", "image/png"),
    "P_curve.png": ("PRECISION_CURVE", "image/png"),
    "R_curve.png": ("RECALL_CURVE", "image/png"),
    "F1_curve.png": ("F1_CURVE", "image/png"),
    "args.yaml": ("ARGS_YAML", "text/yaml"),
}

_EXT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".csv": "text/csv",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".txt": "text/plain",
    ".json": "application/json",
    ".log": "text/plain",
    ".pt": "application/octet-stream",
    ".safetensors": "application/octet-stream",
    ".ckpt": "application/octet-stream",
}


def upload_run_outputs(storage, run_dir: str, owner_path: str, owner_id: str) -> list[dict]:
    """Recursively upload every file under `run_dir` to MinIO.

    `owner_path` is the artifact namespace segment, e.g. "training-job" or
    "benchmark-evaluation"; `owner_id` is the job/evaluation UUID. Returns artifact
    dicts (id/type_code/bucket/object_key/fname/mime/size/checksum) for the DB insert.
    """
    artifacts: list[dict] = []
    if not run_dir or not os.path.isdir(run_dir):
        return artifacts
    for dirpath, dirnames, filenames in os.walk(run_dir):
        # best.pt is dual-stored separately; last.pt is deleted after training.
        if os.path.basename(dirpath) == "weights":
            dirnames[:] = []
            continue
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            if fname.startswith("val_batch"):
                type_code, mime = "VALIDATION_IMAGE", _EXT_MIME.get(os.path.splitext(fname)[1].lower(), "image/jpeg")
            elif fname in _NAME_TYPES:
                type_code, mime = _NAME_TYPES[fname]
            else:
                type_code = "TRAINING_OUTPUT"
                mime = _EXT_MIME.get(os.path.splitext(fname)[1].lower(), "application/octet-stream")
            aid = str(uuid.uuid4())
            key = f"artifacts/{owner_path}/{owner_id}/{aid}/{fname}"
            try:
                info = storage.put_file(key, fpath, mime)
            except Exception:  # noqa: BLE001
                continue
            artifacts.append({
                "id": aid, "type_code": type_code, "bucket": info["bucket"],
                "object_key": info["object_key"], "fname": fname,
                "mime": mime, "size": os.path.getsize(fpath),
                "checksum": _sha256(fpath),
            })
    return artifacts


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()
