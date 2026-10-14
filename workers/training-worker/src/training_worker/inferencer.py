"""Inference run job: re-infer one source dataset with one model and record the
images whose detections disagree with the existing labels
(docs/inference-compare-plan.md).

One job is one row of inference_run_datasets. Only differing images are written,
to inference_diffs, with both box sets snapshotted. The source dataset is only
read (AGENTS.md rule 2). The last job of a run to finish finalises the run, as
benchmark evaluations do.
"""
import csv
import hashlib
import io
import json
import os
import re
import uuid
import zipfile
import shutil
import tempfile

import psycopg

from . import log
from .gpu_alloc import GpuAllocation
from .heartbeat import Heartbeat
from .inference_match import compare, read_label_file

# Same set the scanner registers images from.
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}

# Images per predict call, and per commit: the unit of progress, of stop
# checks, and of work redone after a crash.
CHUNK = 64


class InferenceStopped(Exception):
    pass


class InferenceError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _list_images(images_dir: str, allow_subdirs: bool) -> list[str]:
    """Relative image paths, sorted, skipping what the scanner skips: hidden
    files and directories and symlinks."""
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(images_dir):
        dirnames[:] = sorted(
            d for d in dirnames
            if allow_subdirs and not d.startswith(".") and not os.path.islink(os.path.join(dirpath, d))
        )
        for f in filenames:
            full = os.path.join(dirpath, f)
            if f.startswith(".") or os.path.islink(full) or not os.path.isfile(full):
                continue
            if os.path.splitext(f)[1].lower() in IMAGE_EXTS:
                out.append(os.path.relpath(full, images_dir))
    out.sort()
    return out


def _describe_class_mismatch(model_names: list[str], source_names: list[str]) -> str:
    """Name what differs rather than both lists: a COCO model has 80 classes,
    and the one index that disagrees is what someone needs to see."""
    parts = []
    if len(model_names) != len(source_names):
        parts.append(f"the model has {len(model_names)} classes, the source dataset {len(source_names)}")
    differing = [
        f"{i}: model '{m}' vs source '{s}'"
        for i, (m, s) in enumerate(zip(model_names, source_names)) if m != s
    ]
    if differing:
        shown = "; ".join(differing[:5])
        more = f" (and {len(differing) - 5} more)" if len(differing) > 5 else ""
        parts.append(f"different names at index {shown}{more}")
    return "class lists differ: " + "; ".join(parts)


def _zip_filename(source_name: str, run_name: str) -> str:
    """ASCII only: the download endpoint writes the name into a
    Content-Disposition header, which cannot carry anything else."""
    def safe(v: str) -> str:
        return re.sub(r"[^A-Za-z0-9._-]+", "_", v).strip("._") or "dataset"
    return f"{safe(source_name)}__{safe(run_name)}.zip"


class Inferencer:
    def __init__(self, conn, storage, cfg) -> None:
        self.conn = conn
        self.storage = storage
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        rd_id = payload["inference_run_dataset_id"]
        run_id = payload["inference_run_id"]
        job_execution_id = payload["job_execution_id"]
        assignment_token = payload["assignment_token"]
        correlation_id = payload.get("correlation_id")
        log.info("inference dispatched", inference_run_dataset_id=rd_id, job_execution_id=job_execution_id)

        if not self._claim(rd_id, run_id, job_execution_id, assignment_token, correlation_id):
            return

        work_dir = tempfile.mkdtemp(prefix=f"inference-{rd_id}-")
        try:
            ctx = self._load(rd_id)
            self.conn.commit()
            device = str(ctx["device"] or self.cfg.device)
            with GpuAllocation(self.cfg.pg_conninfo(), job_execution_id, self.cfg.consumer, device):
                with Heartbeat(self.cfg.pg_conninfo(), job_execution_id, self.cfg.heartbeat_interval_s):
                    totals = self._infer(ctx, rd_id, job_execution_id, work_dir, device)
                    package = self._package(ctx, rd_id, work_dir) if totals["diff_images"] else None
            self._complete(ctx, rd_id, run_id, job_execution_id, correlation_id, totals, package)
        except InferenceStopped:
            self._stopped(rd_id, run_id, job_execution_id, correlation_id)
        except InferenceError as ie:
            self._fail(rd_id, run_id, job_execution_id, correlation_id, ie.code, ie.message)
        except Exception as e:  # noqa: BLE001
            import traceback
            log.error("inference failure traceback", inference_run_dataset_id=rd_id, detail=traceback.format_exc()[-2000:])
            self._fail(rd_id, run_id, job_execution_id, correlation_id, "INFERENCE_FAILED", str(e)[:500])
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def _claim(self, rd_id, run_id, job_execution_id, assignment_token, correlation_id) -> bool:
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE job_executions SET status='CLAIMED', claimed_at=now() "
                "WHERE id=%s AND assignment_token=%s AND status='ASSIGNED' RETURNING id",
                (job_execution_id, assignment_token),
            )
            if cur.fetchone() is None:
                log.warn("inference execution not claimable", job_execution_id=job_execution_id)
                self.conn.rollback()
                return False
            cur.execute("UPDATE job_executions SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=%s",
                        (job_execution_id,))
            cur.execute(
                "UPDATE inference_run_datasets SET status='RUNNING', started_at=now() "
                "WHERE id=%s AND status='QUEUED' RETURNING id",
                (rd_id,),
            )
            if cur.fetchone() is None:
                cur.execute(
                    "UPDATE inference_run_datasets SET status='STOPPED', finished_at=now(), stopped_at=now() "
                    "WHERE id=%s AND status='STOPPING' RETURNING id",
                    (rd_id,),
                )
                if cur.fetchone() is not None:
                    log.info("inference stopped before start", inference_run_dataset_id=rd_id)
                    cur.execute("UPDATE job_executions SET status='STOPPED', finished_at=now() WHERE id=%s", (job_execution_id,))
                    self._finalize_run(cur, run_id, None, correlation_id)
                    self.conn.commit()
                    return False
                log.warn("inference dataset not QUEUED (already handled/cancelled)", inference_run_dataset_id=rd_id)
                self.conn.rollback()
                with self.conn.cursor() as cur2:
                    cur2.execute("UPDATE job_executions SET status='CANCELLED', finished_at=now() WHERE id=%s",
                                 (job_execution_id,))
                self.conn.commit()
                return False
            cur.execute(
                "UPDATE inference_runs SET status='RUNNING', started_at=coalesce(started_at, now()), updated_at=now() "
                "WHERE id=%s AND status='QUEUED'",
                (run_id,),
            )
        self.conn.commit()
        return True

    def _load(self, rd_id: str) -> dict:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT r.name, s.name, r.model_id, r.model_checksum_snapshot, r.conf_threshold, r.iou_threshold, r.device, "
                "r.created_by_user_id, m.relative_path, m.model_path, dt.model_path, "
                "a.bucket_name, a.object_key, a.checksum, "
                "s.relative_path, s.images_relative_path, s.labels_relative_path, s.allow_subdirectories, "
                "s.manual_classes_override, d.source_scan_id_snapshot "
                "FROM inference_run_datasets d "
                "JOIN inference_runs r ON r.id = d.inference_run_id "
                "JOIN models m ON m.id = r.model_id "
                "JOIN dataset_types dt ON dt.id = m.dataset_type_id "
                "JOIN source_datasets s ON s.id = d.source_dataset_id "
                "LEFT JOIN artifacts a ON a.id = m.source_artifact_id AND a.artifact_type_code='BEST_MODEL' "
                "WHERE d.id=%s",
                (rd_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise InferenceError("INFERENCE_RUN_DATASET_NOT_FOUND", "inference run dataset not found")
            (run_name, source_name, model_id, checksum_snapshot, conf, iou_threshold, device, created_by,
             m_rel, m_model_path, model_root, bucket, object_key, artifact_checksum,
             s_rel, images_rel, labels_rel, allow_subdirs, classes_override, scan_id) = row

            # The class list the labels were scanned against, as of the scan the
            # run was created on: an admin override wins, as it does when building.
            if classes_override:
                class_names = [str(n) for n in classes_override]
            else:
                cur.execute(
                    "SELECT class_index, class_name FROM source_dataset_classes WHERE scan_id=%s ORDER BY class_index",
                    (scan_id,),
                )
                rows = cur.fetchall()
                class_names = [name for _i, name in rows]
                if [i for i, _n in rows] != list(range(len(rows))):
                    raise InferenceError("INFERENCE_SOURCE_CLASSES_INVALID",
                                         "the source dataset's class indices are not contiguous from 0")
        model_pt = m_model_path or (os.path.join(model_root, m_rel) if model_root else None)
        return {
            "model_id": str(model_id), "checksum_snapshot": checksum_snapshot,
            "conf": float(conf), "iou": float(iou_threshold), "device": (device or "").strip(),
            "created_by": created_by, "model_pt": model_pt,
            "model_artifact": (bucket, object_key, artifact_checksum),
            "images_dir": os.path.join(s_rel, images_rel),
            "labels_dir": os.path.join(s_rel, labels_rel),
            "allow_subdirs": bool(allow_subdirs),
            "class_names": class_names,
            "run_name": run_name, "source_name": source_name,
        }

    def _model_file(self, ctx: dict, work_dir: str) -> str:
        """The model's weights, refusing a file that is not the one the run was
        created with: a run's results must describe a single model."""
        from .model_cache import fetch_model_file
        bucket, object_key, artifact_checksum = ctx["model_artifact"]
        try:
            path = fetch_model_file(self.storage, work_dir, ctx["model_id"], ctx["model_pt"],
                                    bucket, object_key, artifact_checksum)
        except (FileNotFoundError, RuntimeError) as e:
            raise InferenceError("INFERENCE_MODEL_MISSING", str(e)[:500]) from e
        actual = _sha256(path)
        if actual != ctx["checksum_snapshot"]:
            raise InferenceError("INFERENCE_MODEL_CHANGED",
                                 f"the model file changed after the run was created (sha256 {actual[:12]}…, "
                                 f"expected {ctx['checksum_snapshot'][:12]}…)")
        return path

    def _infer(self, ctx: dict, rd_id: str, job_execution_id: str, work_dir: str, device: str) -> dict:
        images_dir, labels_dir = ctx["images_dir"], ctx["labels_dir"]
        if not os.path.isdir(images_dir):
            raise InferenceError("INFERENCE_SOURCE_MISSING", f"images directory not found: {images_dir}")

        model_pt = self._model_file(ctx, work_dir)
        try:
            from ultralytics import YOLO
        except Exception as e:  # noqa: BLE001
            raise InferenceError("INFERENCE_RUNTIME_UNAVAILABLE", f"ultralytics import failed: {e}")
        model = YOLO(model_pt)

        # Labels are class indices, so they only mean the same thing to the
        # model when both lists name the same classes in the same order.
        names = model.names
        model_names = [str(names[i]) for i in sorted(names)] if isinstance(names, dict) else [str(n) for n in names]
        source_names = ctx["class_names"]
        if model_names != source_names:
            raise InferenceError("INFERENCE_CLASS_MISMATCH", _describe_class_mismatch(model_names, source_names))
        class_count = len(source_names)

        images = _list_images(images_dir, ctx["allow_subdirs"])
        with self.conn.cursor() as cur:
            cur.execute("UPDATE inference_run_datasets SET image_count=%s, processed_count=0 WHERE id=%s",
                        (len(images), rd_id))
        self.conn.commit()
        log.info("inference started", inference_run_dataset_id=rd_id, images=len(images), device=device)

        totals = {"processed": 0, "diff_images": 0, "missing": 0, "extra": 0, "class_mismatch": 0}
        for start in range(0, len(images), CHUNK):
            self._check_stop(rd_id)
            chunk = images[start:start + CHUNK]
            results = model.predict(
                source=[os.path.join(images_dir, rel) for rel in chunk],
                conf=ctx["conf"], device=device, verbose=False, stream=True,
            )
            diffs = []
            for rel, res in zip(chunk, results):
                predicted = []
                boxes = res.boxes
                if boxes is not None and len(boxes):
                    for xywhn, cls, conf in zip(boxes.xywhn.tolist(), boxes.cls.tolist(), boxes.conf.tolist()):
                        predicted.append({"class_index": int(cls), "values": [round(v, 6) for v in xywhn],
                                          "conf": round(float(conf), 4)})
                stem = os.path.splitext(rel)[0]
                original, label_ok = read_label_file(os.path.join(labels_dir, f"{stem}.txt"), class_count)
                verdict = compare(original, predicted, ctx["iou"])
                if label_ok and not (verdict["missing"] or verdict["extra"] or verdict["class_mismatch"]):
                    continue
                diffs.append((rel, original, predicted, verdict, not label_ok))
                totals["diff_images"] += 1
                totals["missing"] += verdict["missing"]
                totals["extra"] += verdict["extra"]
                totals["class_mismatch"] += verdict["class_mismatch"]
            totals["processed"] += len(chunk)
            self._write_chunk(rd_id, job_execution_id, diffs, totals, len(images))
        return totals

    def _package(self, ctx: dict, rd_id: str, work_dir: str) -> dict:
        """ZIP the differing images for someone to fix, and upload it.

        Layout is what a labelling tool imports: images/ with the source
        images (subdirectories kept), labels/ with the model's boxes as YOLO
        lines without the confidence, classes.txt, and diff_summary.csv saying
        what disagreed in each image. Labels come from the stored predictions,
        not a fresh run, so the ZIP shows exactly what the compare page shows.

        Images are stored, not deflated: they are already compressed, and
        deflating hundreds of MB of JPEG costs time for no gain.
        """
        filename = _zip_filename(ctx["source_name"], ctx["run_name"])
        zip_path = os.path.join(work_dir, filename)
        summary = io.StringIO()
        writer = csv.writer(summary)
        writer.writerow(["image", "missing", "extra", "class_mismatch", "label_invalid"])
        count = 0
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            # A named cursor streams the rows instead of loading every diff at once.
            with self.conn.cursor(name=f"inference_zip_{rd_id.replace('-', '')}") as cur:
                cur.execute(
                    "SELECT image_relative_path, predicted_boxes, missing_count, extra_count, "
                    "class_mismatch_count, label_invalid FROM inference_diffs "
                    "WHERE inference_run_dataset_id=%s ORDER BY image_relative_path",
                    (rd_id,),
                )
                for rel, predicted, missing, extra, mismatch, label_invalid in cur:
                    arc = rel.replace(os.sep, "/")
                    zf.write(os.path.join(ctx["images_dir"], rel), f"images/{arc}")
                    lines = "".join(
                        f"{b['class_index']} " + " ".join(f"{v:.6f}" for v in b["values"]) + "\n"
                        for b in predicted
                    )
                    zf.writestr(f"labels/{os.path.splitext(arc)[0]}.txt", lines,
                                compress_type=zipfile.ZIP_DEFLATED)
                    writer.writerow([arc, missing, extra, mismatch, "true" if label_invalid else "false"])
                    count += 1
            self.conn.commit()
            zf.writestr("classes.txt", "".join(f"{n}\n" for n in ctx["class_names"]),
                        compress_type=zipfile.ZIP_DEFLATED)
            zf.writestr("diff_summary.csv", summary.getvalue(), compress_type=zipfile.ZIP_DEFLATED)

        artifact_id = str(uuid.uuid4())
        key = f"artifacts/inference-run-dataset/{rd_id}/{artifact_id}/{filename}"
        info = self.storage.put_file(key, zip_path, "application/zip")
        log.info("inference diff zip uploaded", inference_run_dataset_id=rd_id, images=count, bytes=info["size"])
        return {"id": artifact_id, "filename": filename, "image_count": count, **info}

    def _write_chunk(self, rd_id, job_execution_id, diffs, totals, image_count) -> None:
        """One commit per chunk: the diffs and the counters that include them.
        Counters are set, not incremented, so a redone chunk cannot count twice;
        the diff rows upsert on (job, image) for the same reason."""
        with self.conn.cursor() as cur:
            for rel, original, predicted, verdict, label_invalid in diffs:
                cur.execute(
                    "INSERT INTO inference_diffs (inference_run_dataset_id, image_relative_path, original_boxes, "
                    "predicted_boxes, matches, missing_count, extra_count, class_mismatch_count, label_invalid) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (inference_run_dataset_id, image_relative_path) DO UPDATE SET "
                    "original_boxes=EXCLUDED.original_boxes, predicted_boxes=EXCLUDED.predicted_boxes, "
                    "matches=EXCLUDED.matches, missing_count=EXCLUDED.missing_count, "
                    "extra_count=EXCLUDED.extra_count, class_mismatch_count=EXCLUDED.class_mismatch_count, "
                    "label_invalid=EXCLUDED.label_invalid",
                    (rd_id, rel, json.dumps(original), json.dumps(predicted), json.dumps(verdict["matches"]),
                     verdict["missing"], verdict["extra"], verdict["class_mismatch"], label_invalid),
                )
            cur.execute(
                "UPDATE inference_run_datasets SET processed_count=%s, diff_image_count=%s, missing_count=%s, "
                "extra_count=%s, class_mismatch_count=%s WHERE id=%s",
                (totals["processed"], totals["diff_images"], totals["missing"], totals["extra"],
                 totals["class_mismatch"], rd_id),
            )
            pct = int(totals["processed"] * 100 / image_count) if image_count else 100
            cur.execute("UPDATE job_executions SET progress_percent=%s WHERE id=%s", (min(pct, 99), job_execution_id))
        self.conn.commit()

    def _check_stop(self, rd_id: str) -> None:
        with self.conn.cursor() as cur:
            cur.execute("SELECT status FROM inference_run_datasets WHERE id=%s", (rd_id,))
            row = cur.fetchone()
        self.conn.commit()
        if row and row[0] == "STOPPING":
            raise InferenceStopped()

    def _complete(self, ctx, rd_id, run_id, job_execution_id, correlation_id, totals, package) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE inference_run_datasets SET status='COMPLETED', finished_at=now() "
                "WHERE id=%s AND status='RUNNING' RETURNING id",
                (rd_id,),
            )
            if cur.fetchone() is None:
                # Stopped between the last chunk and here.
                self.conn.rollback()
                raise_stop = self._status(rd_id) == "STOPPING"
                if raise_stop:
                    self._stopped(rd_id, run_id, job_execution_id, correlation_id)
                    return
                self._fail(rd_id, run_id, job_execution_id, correlation_id, "INFERENCE_STATE_LOST",
                           "inference dataset left RUNNING before completion")
                return
            if package is not None:
                cur.execute(
                    "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                    "status, bucket_name, object_key, filename, extension, mime_type, file_size_bytes, checksum, "
                    "is_primary, metadata, created_by_actor_type, created_by_actor_ref, verified_at) "
                    "VALUES (%s,'INFERENCE_RUN_DATASET',%s,'INFERENCE_DIFF_ZIP',%s,'VERIFIED',%s,%s,%s,'.zip',"
                    "'application/zip',%s,%s,true,%s,'WORKER',%s,now())",
                    (package["id"], rd_id, job_execution_id, package["bucket"], package["object_key"],
                     package["filename"], package["size"], package["checksum"],
                     json.dumps({"image_count": package["image_count"]}), self.cfg.consumer),
                )
                cur.execute("UPDATE inference_run_datasets SET zip_artifact_id=%s WHERE id=%s", (package["id"], rd_id))
            cur.execute("UPDATE job_executions SET status='SUCCEEDED', finished_at=now(), progress_percent=100 WHERE id=%s",
                        (job_execution_id,))
            self._audit(cur, rd_id, correlation_id, "INFERENCE_DATASET_COMPLETED", "SUCCESS", totals)
            self._finalize_run(cur, run_id, ctx.get("created_by"), correlation_id)
        self.conn.commit()
        log.info("inference dataset completed", inference_run_dataset_id=rd_id, **totals)

    def _status(self, rd_id: str):
        with self.conn.cursor() as cur:
            cur.execute("SELECT status FROM inference_run_datasets WHERE id=%s", (rd_id,))
            row = cur.fetchone()
        self.conn.commit()
        return row[0] if row else None

    def _stopped(self, rd_id, run_id, job_execution_id, correlation_id) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE inference_run_datasets SET status='STOPPED', finished_at=now(), stopped_at=now() "
                "WHERE id=%s AND status='STOPPING' RETURNING id",
                (rd_id,),
            )
            if cur.fetchone() is not None:
                cur.execute("UPDATE job_executions SET status='STOPPED', finished_at=now() WHERE id=%s", (job_execution_id,))
                self._audit(cur, rd_id, correlation_id, "INFERENCE_DATASET_STOPPED", "SUCCESS",
                            {"from": "STOPPING", "to": "STOPPED"})
            self._finalize_run(cur, run_id, None, correlation_id)
        self.conn.commit()
        log.info("inference dataset stopped", inference_run_dataset_id=rd_id)

    def _fail(self, rd_id, run_id, job_execution_id, correlation_id, code, message) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE inference_run_datasets SET status='FAILED', finished_at=now(), failure_code=%s, failure_message=%s "
                "WHERE id=%s AND status NOT IN ('COMPLETED','CANCELLED') RETURNING id",
                (code, message[:1000], rd_id),
            )
            cur.execute("UPDATE job_executions SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                        (code, message[:1000], job_execution_id))
            self._audit(cur, rd_id, correlation_id, "INFERENCE_DATASET_FAILED", "FAILURE",
                        {"failure_code": code}, error_code=code, error_message=message[:1000])
            self._finalize_run(cur, run_id, None, correlation_id)
        self.conn.commit()
        log.error("inference dataset failed", inference_run_dataset_id=rd_id, error_code=code, detail=message[:200])

    def _finalize_run(self, cur, run_id, created_by, correlation_id) -> None:
        cur.execute(
            "SELECT count(*) FILTER (WHERE status='COMPLETED'), count(*) FILTER (WHERE status='FAILED'), "
            "count(*) FILTER (WHERE status='STOPPED'), "
            "count(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED','STOPPED')), count(*) "
            "FROM inference_run_datasets WHERE inference_run_id=%s",
            (run_id,),
        )
        completed, failed, stopped, pending, total = cur.fetchone()
        cur.execute("UPDATE inference_runs SET completed_count=%s, failed_count=%s, updated_at=now() WHERE id=%s",
                    (completed, failed, run_id))
        if pending or not total:
            return
        if stopped > 0:
            status = "STOPPED"
        else:
            status = "COMPLETED" if failed == 0 else ("PARTIALLY_FAILED" if completed > 0 else "FAILED")
        cur.execute(
            "UPDATE inference_runs SET status=%s, finished_at=now(), "
            "stopped_at=(CASE WHEN %s='STOPPED' THEN now() ELSE stopped_at END), updated_at=now() "
            "WHERE id=%s AND status IN ('RUNNING','STOPPING') RETURNING id",
            (status, status, run_id),
        )
        if cur.fetchone() is None:
            return
        aid = self._audit(cur, run_id, correlation_id, "INFERENCE_RUN_FINISHED",
                          "SUCCESS" if status in ("COMPLETED", "STOPPED") else "FAILURE",
                          {"status": status, "completed": completed, "failed": failed},
                          resource_type="INFERENCE_RUN")
        if not created_by:
            cur.execute("SELECT created_by_user_id FROM inference_runs WHERE id=%s", (run_id,))
            created_by = cur.fetchone()[0]
        sev = "SUCCESS" if status == "COMPLETED" else ("WARNING" if status in ("PARTIALLY_FAILED", "STOPPED") else "ERROR")
        cur.execute(
            "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
            "resource_type_code, resource_id) VALUES (%s,%s,%s,'Inference Finished',%s,'INFERENCE_RUN',%s)",
            (aid, created_by, sev, f"Inference finished: {status} ({completed} ok, {failed} failed).", run_id),
        )

    def _audit(self, cur, resource_id, correlation_id, action, result, metadata,
               resource_type="INFERENCE_RUN_DATASET", error_code=None, error_message=None) -> int:
        cur.execute(
            "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
            "result, correlation_id, metadata, error_code, error_message) "
            "VALUES ('WORKER',%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (self.cfg.consumer, action, resource_type, resource_id, result, correlation_id,
             json.dumps(metadata), error_code, error_message),
        )
        return cur.fetchone()[0]
