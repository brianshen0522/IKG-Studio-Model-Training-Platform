"""Compare a model's detections with an image's existing labels.

Pure functions apart from reading one label file, so the rules can be checked
without a model (docs/inference-compare-plan.md §4).

Boxes are YOLO-normalised (cx, cy, w, h). IoU is computed in those units
directly: scaling x and y by different factors scales every area, the
intersection's and the union's alike, by the same product, so the ratio is the
one the pixel boxes would give and no image size is needed.
"""
import math

# Per-box verdicts, stored in inference_diffs.matches.
MATCH = "MATCH"
CLASS_MISMATCH = "CLASS_MISMATCH"
MISSING = "MISSING"  # in the original labels, no prediction over it
EXTRA = "EXTRA"      # predicted, nothing in the original labels under it

DETECT_FIELDS = 5


def read_label_file(path: str, class_count: int) -> tuple[list[dict], bool]:
    """The boxes in a DETECT label file, and whether every line was usable.

    A missing file is an image with no objects, not an error. A line that cannot
    be read as a box (wrong field count, non-numeric or non-finite values, a
    class index outside the class list, zero size) is left out of the boxes and
    makes the image count as different: it cannot be compared, so someone has
    to look at it. A trailing sixth field is a confidence and is accepted, as
    the scanner accepts it.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except FileNotFoundError:
        return [], True
    except (OSError, UnicodeDecodeError):
        return [], False
    boxes: list[dict] = []
    valid = True
    for raw in lines:
        parts = raw.split()
        if not parts:
            continue
        if len(parts) not in (DETECT_FIELDS, DETECT_FIELDS + 1):
            valid = False
            continue
        try:
            cls = int(parts[0])
            values = [float(v) for v in parts[1:DETECT_FIELDS]]
        except ValueError:
            valid = False
            continue
        if not all(math.isfinite(v) for v in values) or not 0 <= cls < class_count:
            valid = False
            continue
        if values[2] <= 0 or values[3] <= 0:
            valid = False
            continue
        boxes.append({"class_index": cls, "values": values})
    return boxes, valid


def iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a[0] - a[2] / 2, a[1] - a[3] / 2, a[0] + a[2] / 2, a[1] + a[3] / 2
    bx1, by1, bx2, by2 = b[0] - b[2] / 2, b[1] - b[3] / 2, b[0] + b[2] / 2, b[1] + b[3] / 2
    iw = min(ax2, bx2) - max(ax1, bx1)
    ih = min(ay2, by2) - max(ay1, by1)
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def compare(original: list[dict], predicted: list[dict], iou_threshold: float) -> dict:
    """Pair original and predicted boxes one-to-one and give each a verdict.

    Pairing ignores class: a box drawn in the right place with the wrong class
    is reported as one CLASS_MISMATCH, not as a MISSING plus an EXTRA, because
    that is what someone fixing it has to do. Pairs are taken greedily from the
    highest IoU down, so each box joins the partner it overlaps most that is
    still free; a pair below the threshold is no pair.

    Returns the verdict list (pairs first, in IoU order, then the unpaired
    boxes) and the counts of each kind of disagreement.
    """
    candidates = []
    for i, o in enumerate(original):
        for j, p in enumerate(predicted):
            v = iou(o["values"], p["values"])
            if v >= iou_threshold:
                candidates.append((v, i, j))
    # Ties broken by index so the same input always pairs the same way.
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]))

    used_o: set[int] = set()
    used_p: set[int] = set()
    matches: list[dict] = []
    counts = {"missing": 0, "extra": 0, "class_mismatch": 0}
    for v, i, j in candidates:
        if i in used_o or j in used_p:
            continue
        used_o.add(i)
        used_p.add(j)
        same = original[i]["class_index"] == predicted[j]["class_index"]
        if not same:
            counts["class_mismatch"] += 1
        matches.append({"kind": MATCH if same else CLASS_MISMATCH,
                        "original": i, "predicted": j, "iou": round(v, 4)})
    for i in range(len(original)):
        if i not in used_o:
            counts["missing"] += 1
            matches.append({"kind": MISSING, "original": i, "predicted": None, "iou": None})
    for j in range(len(predicted)):
        if j not in used_p:
            counts["extra"] += 1
            matches.append({"kind": EXTRA, "original": None, "predicted": j, "iou": None})
    return {"matches": matches, **counts}
