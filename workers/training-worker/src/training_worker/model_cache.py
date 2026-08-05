"""Download-on-demand model weights.

Trained models are dual-stored (MinIO artifact + Model Root copy), but the Model Root
copy is deleted once the training job that produced it finishes. Consumers that need a
model's weights (training with a base model, benchmark) prefer the on-disk copy and fall
back to pulling the BEST_MODEL artifact back from MinIO into a per-run temp directory;
that temp dir is deleted when the run ends.
"""

import hashlib
import os


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_model_file(storage, dest_dir: str, model_id: str, local_path: str,
                     bucket: str, object_key: str, checksum: str) -> str:
    """Return a usable local weights path for ``model_id``.

    Prefers the on-disk Model Root copy. If absent, downloads the BEST_MODEL MinIO
    artifact into ``dest_dir`` and verifies its SHA-256. Raises when neither exists.
    """
    if local_path and os.path.isfile(local_path):
        return local_path
    if not (bucket and object_key):
        raise FileNotFoundError(f"model {model_id}: no on-disk file and no MinIO artifact to restore from")
    os.makedirs(dest_dir, exist_ok=True)
    local = os.path.join(dest_dir, f"{model_id}.pt")
    storage.get_file(bucket, object_key, local)
    if checksum and _sha256(local) != checksum:
        os.remove(local)
        raise RuntimeError(f"model {model_id}: downloaded artifact checksum mismatch")
    return local
