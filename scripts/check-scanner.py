"""Self-check for the relaxed scanner rules:
- missing image/label pairs are WARNING, never INVALID
- image_count counts only paired (image+valid label) images
Run: python3 scripts/check-scanner.py
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "workers/dataset-worker/src"))
from dataset_worker.scanner import scan  # noqa: E402


def make_dataset(tmp: str, n: int) -> None:
    images = os.path.join(tmp, "images")
    labels = os.path.join(tmp, "labels")
    os.makedirs(images)
    os.makedirs(labels)
    from PIL import Image

    for i in range(n):
        img = Image.new("RGB", (32, 32), (i * 40, 0, 0))
        img.save(os.path.join(images, f"img{i:02d}.png"))
    # one orphan label (no image)
    with open(os.path.join(labels, "orphan.txt"), "w") as f:
        f.write("0 0.5 0.5 0.2 0.2\n")
    # img01 has no label -> missing label, should NOT count in image_count
    with open(os.path.join(labels, "img00.txt"), "w") as f:
        f.write("0 0.5 0.5 0.2 0.2\n")
    with open(os.path.join(labels, "img02.txt"), "w") as f:
        f.write("0 0.5 0.5 0.2 0.2\n")


with tempfile.TemporaryDirectory() as tmp:
    make_dataset(tmp, 3)
    res = scan(os.path.join(tmp, "images"), os.path.join(tmp, "labels"),
               None, "DETECT", allow_subdirs=False)

    assert res.status == "READY", f"expected READY, got {res.status}"
    assert res.image_count == 2, f"image_count should count only pairs, got {res.image_count}"
    assert res.matched_pair_count == 2, f"expected 2 pairs, got {res.matched_pair_count}"
    assert res.missing_label_count == 1, f"expected 1 missing label, got {res.missing_label_count}"
    assert res.missing_image_count == 1, f"expected 1 missing image, got {res.missing_image_count}"
    codes = {i["issue_code"] for i in res.issues}
    assert "DATASET_MISSING_LABEL" in codes and "DATASET_MISSING_IMAGE" in codes
    errs = [i for i in res.issues if i["severity"] == "ERROR"]
    assert not errs, f"missing pairs must be WARNING, got errors: {errs}"
    assert res.has_warnings, "missing pairs should set has_warnings"

print("scanner self-check OK")
