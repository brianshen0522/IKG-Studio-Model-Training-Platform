"""Self-check for data.yaml handling: a registered dataset may not carry code to run.
Run: uv run --project workers/dataset-worker python scripts/check-data-yaml.py
"""
import importlib.util
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "workers/dataset-worker/src"))
from dataset_worker.worker import DatasetWorker, ScanError  # noqa: E402

# Loaded by path: the training-worker package imports torch-side modules.
spec = importlib.util.spec_from_file_location(
    "data_yaml", os.path.join(ROOT, "workers/training-worker/src/training_worker/data_yaml.py"))
data_yaml = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data_yaml)

BASE = "path: /data/x\ntrain: images/train\nval: images/val\nnames: {0: a}\n"
GOOD = [BASE, BASE + "download: https://example.invalid/set.zip\n"]
BAD = [
    BASE + "download: bash run.sh\n",
    BASE + "download: |\n  import os\n  os.remove('x')\n",
    BASE + "download: https://example.invalid/a.zip\\nimport os\n".replace("\\n", " "),
    BASE + "download: [a, b]\n",
]


def rejected_by_scan(root: str) -> bool:
    worker = DatasetWorker.__new__(DatasetWorker)
    try:
        worker._validate_training_dataset(os.path.join(root, "data.yaml"), "x", "DETECT")
    except ScanError as e:
        return e.code == "TRAINING_DATA_YAML_INVALID"
    return False


with tempfile.TemporaryDirectory() as root:
    os.makedirs(os.path.join(root, "images/train"))
    os.makedirs(os.path.join(root, "labels/train"))
    with open(os.path.join(root, "images/train/a.jpg"), "wb") as f:
        f.write(b"x")
    with open(os.path.join(root, "labels/train/a.txt"), "w") as f:
        f.write("0 0.5 0.5 0.1 0.1\n")
    path = os.path.join(root, "data.yaml")
    for text in GOOD + BAD:
        with open(path, "w") as f:
            f.write(text)
        expected_bad = text in BAD
        assert (data_yaml.problem(path) is not None) == expected_bad, text
        assert rejected_by_scan(root) == expected_bad, text

    # Ultralytics drops control characters before parsing, so these must not slip past.
    with open(path, "w") as f:
        f.write(BASE + "download: bash run.sh\x01\n")
    assert data_yaml.problem(path) is not None

print("data.yaml guard ok")
