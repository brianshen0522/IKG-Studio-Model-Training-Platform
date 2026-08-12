import hashlib
import os

from PIL import Image

Image.MAX_IMAGE_PIXELS = 200_000_000  # guard against decompression bombs

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
TEMP_SUFFIXES = (".tmp", ".temp", ".part", ".swp", "~")
# Geometry field count, class id included. Dataset Manager may append one optional
# trailing confidence column (doc/plan-yolo-label-confidence.md), so a label row is
# valid at either FIELD_COUNT[task] or FIELD_COUNT[task] + 1 fields. Ultralytics
# itself rejects the extra column, so the builder strips it on the way in.
FIELD_COUNT = {"DETECT": 5, "OBB": 9}
# Box edges sticking slightly past the image border are clipped to [0,1] at build
# time (see builder._write_label) — that's annotation noise, a WARNING. A box
# beyond this tolerance is garbage data and fails the label.
COORD_TOLERANCE = 0.1


def _is_hidden(name: str) -> bool:
    return name.startswith(".")


def _is_temp(name: str) -> bool:
    return any(name.endswith(s) for s in TEMP_SUFFIXES)


class ScanResult:
    def __init__(self) -> None:
        self.image_count = 0
        self.label_count = 0
        self.matched_pair_count = 0
        self.missing_image_count = 0
        self.missing_label_count = 0
        self.invalid_label_count = 0
        self.empty_label_count = 0
        self.confidence_label_count = 0  # rows carrying the optional trailing confidence
        self.ignored_file_count = 0
        self.class_count = 0
        self.classes: list[dict] = []
        self.classes_source = "LABEL_INFERENCE"
        self.issues: list[dict] = []
        self.items: list[dict] = []
        self.content_hash = ""
        self.classes_hash = ""
        self.status = "READY"
        self.has_warnings = False

    def issue(self, severity, code, image=None, label=None, line=None, **details):
        self.issues.append({
            "severity": severity, "issue_code": code,
            "image_relative_path": image, "label_relative_path": label,
            "line_number": line, "details": details,
        })
        if severity == "WARNING":
            self.has_warnings = True


def _walk(root: str, allow_subdirs: bool, res: ScanResult):
    """Yield (relpath, abspath) for non-hidden regular files; record ignored ones."""
    for dirpath, dirnames, filenames in os.walk(root):
        # prune hidden / symlinked directories
        kept = []
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            if _is_hidden(d) or os.path.islink(full):
                res.ignored_file_count += 1
                if os.path.islink(full):
                    res.issue("WARNING", "DATASET_SCAN_SYMLINK_IGNORED", image=os.path.relpath(full, root))
                continue
            kept.append(d)
        dirnames[:] = kept if allow_subdirs else []
        if not allow_subdirs and dirpath != root:
            continue
        for f in filenames:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, root)
            if _is_hidden(f) or _is_temp(f):
                res.ignored_file_count += 1
                continue
            if os.path.islink(full):
                res.ignored_file_count += 1
                res.issue("WARNING", "DATASET_SCAN_SYMLINK_IGNORED", image=rel)
                continue
            if not os.path.isfile(full):
                res.ignored_file_count += 1
                continue
            yield rel, full


def _validate_label(path: str, rel: str, task_type: str, res: ScanResult) -> tuple[bool, list[int]]:
    """Return (is_valid, class_ids). Records issues + empty."""
    expected = FIELD_COUNT.get(task_type)
    if expected is None:
        res.issue("ERROR", "DATASET_TASK_NOT_IMPLEMENTED", label=rel)
        return False, []
    class_ids: list[int] = []
    valid = True
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except Exception as e:
        res.issue("ERROR", "DATASET_LABEL_INVALID", label=rel, error=str(e)[:200])
        return False, []
    non_empty = [(i + 1, ln.strip()) for i, ln in enumerate(lines) if ln.strip()]
    if not non_empty:
        res.empty_label_count += 1
        return True, []
    for lineno, line in non_empty:
        parts = line.split()
        if len(parts) not in (expected, expected + 1):
            res.issue("ERROR", "DATASET_LABEL_INVALID", label=rel, line=lineno,
                      raw=line[:200],
                      reason=f"expected {expected} fields, or {expected + 1} with a trailing "
                             f"confidence, got {len(parts)}")
            valid = False
            continue
        try:
            cid = int(parts[0])
        except ValueError:
            res.issue("ERROR", "DATASET_CLASS_INDEX_INVALID", label=rel, line=lineno, raw=line[:200])
            valid = False
            continue
        if cid < 0:
            res.issue("ERROR", "DATASET_CLASS_INDEX_INVALID", label=rel, line=lineno, raw=line[:200])
            valid = False
            continue
        coords_ok = True
        coords = []
        for tok in parts[1:expected]:
            try:
                v = float(tok)
            except ValueError:
                coords_ok = False
                break
            coords.append(v)
        if not coords_ok:
            res.issue("ERROR", "DATASET_LABEL_INVALID", label=rel, line=lineno, raw=line[:200], reason="non-numeric coordinate")
            valid = False
            continue
        if len(parts) == expected + 1:
            # Confidence is dropped before training, but a malformed value means the row
            # was not produced by the pipeline we think it was — fail loudly.
            try:
                conf = float(parts[expected])
            except ValueError:
                res.issue("ERROR", "DATASET_LABEL_INVALID", label=rel, line=lineno, raw=line[:200],
                          reason="non-numeric confidence")
                valid = False
                continue
            if conf < 0.0 or conf > 1.0:
                res.issue("ERROR", "DATASET_LABEL_INVALID", label=rel, line=lineno, raw=line[:200],
                          reason="confidence must be within 0..1")
                valid = False
                continue
            res.confidence_label_count += 1
        if any(c < -COORD_TOLERANCE or c > 1.0 + COORD_TOLERANCE for c in coords):
            res.issue("ERROR", "DATASET_LABEL_COORDINATE_OUT_OF_RANGE", label=rel, line=lineno, raw=line[:200])
            valid = False
            continue
        if any(c < 0.0 or c > 1.0 for c in coords):
            # Slightly off-canvas box: kept as a valid pair, clipped to [0,1] at
            # build time.
            res.issue("WARNING", "DATASET_LABEL_COORDINATE_OUT_OF_RANGE", label=rel, line=lineno, raw=line[:200])
        if task_type == "DETECT" and (coords[2] <= 0 or coords[3] <= 0):
            res.issue("ERROR", "DATASET_LABEL_INVALID", label=rel, line=lineno, raw=line[:200], reason="width/height must be > 0")
            valid = False
            continue
        class_ids.append(cid)
    return valid, class_ids


def _remove_invalid_pair(image_full: str, label_full: str | None) -> bool:
    """Delete a corrupt image and its matching label. Returns True if the image
    was removed (a label that fails to delete is left to surface as an orphan)."""
    try:
        os.remove(image_full)
    except OSError:
        return False
    if label_full:
        try:
            os.remove(label_full)
        except OSError:
            pass
    return True


def _parse_classes_file(path: str, res: ScanResult) -> list[str] | None:
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            raw = fh.read()
    except Exception as e:
        res.issue("ERROR", "DATASET_CLASSES_FILE_INVALID", label=path, error=str(e)[:200])
        return None
    names: list[str] = []
    for i, line in enumerate(raw.splitlines()):
        name = line.strip()
        if name == "":
            res.issue("ERROR", "DATASET_CLASSES_FILE_INVALID", line=i + 1, reason="blank line not allowed")
            return None
        if "\0" in name or len(name) > 200:
            res.issue("ERROR", "DATASET_CLASSES_FILE_INVALID", line=i + 1, reason="invalid class name")
            return None
        names.append(name)
    if len(names) != len(set(names)):
        res.issue("ERROR", "DATASET_DUPLICATE_CLASS_NAME")
        return None
    return names


def compute_content_hash(images_dir: str, labels_dir: str, allow_subdirs: bool) -> str:
    """Recompute the aggregate content hash of a source dataset's images+labels.

    Must stay byte-identical to the hashing block in scan() so the build worker can
    detect source drift (DATASET_SOURCE_CHANGED_SINCE_SCAN) against a stored scan hash.
    """
    junk = ScanResult()
    images: dict[str, str] = {}
    image_meta: dict[str, dict] = {}
    for rel, full in _walk(images_dir, allow_subdirs, junk):
        if os.path.splitext(rel)[1].lower() not in IMAGE_EXTS:
            continue
        stem = os.path.splitext(rel)[0]
        images[stem] = full
        image_meta[stem] = {"rel": rel}
    labels: dict[str, str] = {}
    for rel, full in _walk(labels_dir, allow_subdirs, junk):
        if os.path.splitext(rel)[1].lower() != ".txt":
            continue
        labels[os.path.splitext(rel)[0]] = full
    hasher = hashlib.sha256()
    for stem in sorted(images):
        st = os.stat(images[stem])
        hasher.update(f"{image_meta[stem]['rel']}:{st.st_size}:{int(st.st_mtime)}\n".encode("utf-8"))
    for stem in sorted(labels):
        st = os.stat(labels[stem])
        hasher.update(f"L:{stem}:{st.st_size}:{int(st.st_mtime)}\n".encode("utf-8"))
    return hasher.hexdigest()


def scan(images_dir: str, labels_dir: str, classes_file: str | None,
         task_type: str, allow_subdirs: bool,
         fallback_names: list[str] | None = None,
         manual_override_names: list[str] | None = None,
         on_progress=None) -> ScanResult:
    res = ScanResult()

    def _report(pct: float, message: str) -> None:
        if on_progress:
            on_progress(pct, message)

    images: dict[str, str] = {}      # stem-relpath -> abspath
    image_meta: dict[str, dict] = {}
    dup_stems: set[str] = set()
    for rel, full in _walk(images_dir, allow_subdirs, res):
        ext = os.path.splitext(rel)[1].lower()
        if ext not in IMAGE_EXTS:
            res.ignored_file_count += 1
            continue
        stem = os.path.splitext(rel)[0]
        if stem in images:
            dup_stems.add(stem)
        images[stem] = full
        image_meta[stem] = {"rel": rel, "ext": ext}

    for stem in dup_stems:
        res.issue("ERROR", "DATASET_DUPLICATE_IMAGE_STEM", image=stem)

    _report(30, f"Scanned {len(images)} images")

    labels: dict[str, str] = {}
    for rel, full in _walk(labels_dir, allow_subdirs, res):
        if os.path.splitext(rel)[1].lower() != ".txt":
            res.ignored_file_count += 1
            continue
        stem = os.path.splitext(rel)[0]
        res.label_count += 1
        labels[stem] = full

    _report(40, f"Scanned {res.label_count} label files")

    # deep-validate images + pair with labels
    class_object_counts: dict[int, int] = {}
    max_class_id = -1
    removed_stems: set[str] = set()
    for idx, (stem, full) in enumerate(images.items()):
        meta = image_meta[stem]
        try:
            with Image.open(full) as im:
                im.verify()
            with Image.open(full) as im2:
                w, h = im2.size
            if w <= 0 or h <= 0:
                raise ValueError("non-positive dimensions")
            meta["width"], meta["height"] = w, h
        except Exception as e:
            # An unreadable/corrupt image can never train and would fail every
            # re-scan forever — delete it and its matching label so the pair can't
            # keep blocking the dataset (deliberate override of the source-folder
            # read-only rule). If deletion fails, keep the hard ERROR instead.
            label_full = labels.get(stem)
            if _remove_invalid_pair(full, label_full):
                removed_stems.add(stem)
                res.issue("WARNING", "DATASET_IMAGE_INVALID_REMOVED", image=meta["rel"],
                          label=os.path.relpath(label_full, labels_dir) if label_full else None,
                          error=str(e)[:200])
                continue
            res.issue("ERROR", "DATASET_IMAGE_INVALID", image=meta["rel"], error=str(e)[:200])

        label_full = labels.get(stem)
        if label_full is None:
            res.missing_label_count += 1
            # A label absent for an image is a data gap, not corruption — the pair
            # simply never trains. WARNING (not ERROR) so a handful of unlabelled
            # images don't fail the whole dataset.
            res.issue("WARNING", "DATASET_MISSING_LABEL", image=meta["rel"])
            continue
        valid, cids = _validate_label(label_full, os.path.relpath(label_full, labels_dir), task_type, res)
        if not valid:
            res.invalid_label_count += 1
        else:
            res.matched_pair_count += 1
            # image_count counts only images that end up training (have a valid
            # label) — a missing pair shows up under missing_label_count instead of
            # inflating the headline image number.
            res.image_count += 1
            res.items.append({
                "image_relative_path": meta["rel"],
                "label_relative_path": os.path.relpath(label_full, labels_dir),
                "width": meta.get("width"), "height": meta.get("height"),
            })
        for cid in cids:
            class_object_counts[cid] = class_object_counts.get(cid, 0) + 1
            max_class_id = max(max_class_id, cid)

        if idx % 500 == 0:
            _report(40 + 45 * (idx + 1) / (len(images) or 1),
                    f"Validating image {idx + 1}/{len(images)}")

    # Corrupt images (and their labels) were deleted in the loop above; drop them
    # from the working sets so the orphan-label pass and the content hash match
    # what is actually on disk now.
    for stem in removed_stems:
        images.pop(stem, None)
        image_meta.pop(stem, None)
        labels.pop(stem, None)

    for stem, full in labels.items():
        if stem not in images:
            res.missing_image_count += 1
            # Same rule as DATASET_MISSING_LABEL: an orphan label never trains and
            # is a WARNING, not a reason to invalidate the dataset.
            res.issue("WARNING", "DATASET_MISSING_IMAGE", label=os.path.relpath(full, labels_dir))

    _report(85, "Image/label validation complete")

    # classes
    names: list[str] | None = None
    if manual_override_names:
        # Admin-supplied class list (DB metadata, never written to the read-only source
        # folder). Highest priority: chosen specifically for this dataset, it replaces
        # even an on-disk classes.txt.
        names = manual_override_names
        res.classes_source = "MANUAL_OVERRIDE"
    elif classes_file and os.path.isfile(classes_file):
        names = _parse_classes_file(classes_file, res)
        if names is not None:
            res.classes_source = "CLASSES_FILE"
    elif classes_file:
        res.issue("ERROR", "DATASET_CLASSES_FILE_NOT_FOUND", label=classes_file)

    if names is None and res.classes_source != "CLASSES_FILE" and fallback_names:
        # No classes.txt of its own: reuse the most-common classes.txt among other
        # source datasets of the same dataset type, rather than guessing placeholder
        # names from whatever label indices happen to appear in this one folder.
        names = fallback_names
        res.classes_source = "TYPE_FALLBACK"
        res.issue("WARNING", "DATASET_CLASSES_FALLBACK", count=len(names))

    if names is None and res.classes_source != "CLASSES_FILE":
        # infer from labels
        if max_class_id >= 0:
            names = [f"class_{i}" for i in range(max_class_id + 1)]
            res.classes_source = "LABEL_INFERENCE"
            res.issue("WARNING", "DATASET_CLASSES_INFERRED", count=len(names))

    if names is not None:
        # contiguity check against used ids
        if max_class_id >= 0 and max_class_id >= len(names):
            res.issue("ERROR", "DATASET_CLASS_INDEX_GAP", reason="label class id exceeds class count")
        used = set(class_object_counts.keys())
        for i in range(len(names)):
            if max_class_id >= 0 and i <= max_class_id and i not in used and res.classes_source == "LABEL_INFERENCE":
                # A partial sample rarely covers every inferred index — absence of a
                # class is not corruption. Keep it a warning so such datasets can still
                # be built and trained. Indexes beyond the class count stay an ERROR above.
                res.issue("WARNING", "DATASET_CLASS_INDEX_GAP", reason=f"missing class index {i}")
        res.class_count = len(names)
        for i, nm in enumerate(names):
            res.classes.append({
                "class_index": i, "class_name": nm,
                "source": res.classes_source, "object_count": class_object_counts.get(i, 0),
            })
        res.classes_hash = hashlib.sha256(
            "\n".join(f"{i}:{nm}" for i, nm in enumerate(names)).encode("utf-8")
        ).hexdigest()

    _report(90, f"Classes resolved ({res.class_count or 0} classes)")

    # content hash from image+label metadata (path/size/mtime)
    _report(95, "Computing content hash")
    hasher = hashlib.sha256()
    for stem in sorted(images):
        full = images[stem]
        st = os.stat(full)
        hasher.update(f"{image_meta[stem]['rel']}:{st.st_size}:{int(st.st_mtime)}\n".encode("utf-8"))
    for stem in sorted(labels):
        st = os.stat(labels[stem])
        hasher.update(f"L:{stem}:{st.st_size}:{int(st.st_mtime)}\n".encode("utf-8"))
    res.content_hash = hasher.hexdigest()

    # status
    error_issues = [i for i in res.issues if i["severity"] == "ERROR"]
    if (res.image_count == 0 or res.matched_pair_count == 0 or error_issues
            or names is None):
        res.status = "INVALID"
    else:
        res.status = "READY"

    res.error_count = len(error_issues)
    res.warning_count = len([i for i in res.issues if i["severity"] == "WARNING"])
    return res
