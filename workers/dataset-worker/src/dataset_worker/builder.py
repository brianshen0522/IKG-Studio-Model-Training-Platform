"""Managed Dataset build (doc 06 §29-45, §70-71).

Consumes a DATASET_BUILD job: merges source pairs, computes the split, materialises
images/labels into an Ultralytics dataset root (COPY/HARDLINK) via a staging directory
with atomic publish, emits data.yaml + Split Manifest artifacts, and finalises the
dataset to READY (or INVALID on failure).
"""
import errno
import hashlib
import json
import os
import random
import shutil
import uuid

import yaml

from . import joblog, log, scanner

SPLITS = ("train", "val", "test")


class BuildError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _largest_remainder(n: int, ratios: dict) -> dict:
    raw = {s: ratios[s] * n for s in SPLITS}
    base = {s: int(raw[s]) for s in SPLITS}
    rem = n - sum(base.values())
    order = sorted(SPLITS, key=lambda s: (-(raw[s] - base[s]), SPLITS.index(s)))
    for i in range(rem):
        base[order[i]] += 1
    return base


def _copy_or_link(src: str, dst: str, mode: str) -> None:
    if mode == "HARDLINK":
        try:
            os.link(src, dst)
        except OSError as e:
            if e.errno == errno.EXDEV:
                raise BuildError("DATASET_HARDLINK_NOT_SUPPORTED", "source and target on different file systems")
            raise BuildError("DATASET_HARDLINK_NOT_SUPPORTED", str(e)[:200])
    else:
        shutil.copy2(src, dst)


def _write_label(src: str, dst: str, mode: str, expected: int | None) -> bool:
    """Materialise one label file, dropping the optional trailing confidence column
    and clipping box edges to [0,1].

    Dataset Manager may emit `cls cx cy w h confidence` (and the OBB equivalent);
    the scanner accepts those, but Ultralytics does not — `verify_image_label`
    asserts exactly 5 columns for DETECT. And the scanner tolerates boxes that
    stick slightly past the image border (WARNING), which Ultralytics likewise
    dislikes. So a row carrying confidence or an out-of-range coordinate has to
    be rewritten rather than copied. Hardlinking a rewritten file would edit the
    read-only source, so such files degrade to a real write regardless of
    storage_mode. Returns True when the file was rewritten.
    """
    if expected is None:
        _copy_or_link(src, dst, mode)
        return False
    with open(src, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
    rows = [ln.split() for ln in lines if ln.split()]
    if not rows:
        _copy_or_link(src, dst, mode)
        return False
    needs_rewrite = False
    out = []
    for parts in rows:
        keep = parts[:expected]
        if len(parts) == expected + 1:
            needs_rewrite = True
        for i in range(1, len(keep)):
            try:
                v = float(keep[i])
            except ValueError:
                continue
            if v < 0.0 or v > 1.0:
                keep[i] = str(max(0.0, min(1.0, v)))
                needs_rewrite = True
        out.append(" ".join(keep))
    if not needs_rewrite:
        _copy_or_link(src, dst, mode)
        return False
    with open(dst, "w", encoding="utf-8") as fh:
        fh.write("".join(r + "\n" for r in out))
    return True


class DatasetBuilder:
    def __init__(self, conn, storage, cfg) -> None:
        self.conn = conn
        self.storage = storage
        self.cfg = cfg

    def run(self, payload: dict) -> None:
        dataset_id = payload["training_dataset_id"]
        job_execution_id = payload["job_execution_id"]
        assignment_token = payload["assignment_token"]
        correlation_id = payload.get("correlation_id")
        log.info("dataset build dispatched", dataset_id=dataset_id, job_execution_id=job_execution_id)

        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE job_executions SET status='CLAIMED', claimed_at=now() "
                "WHERE id=%s AND assignment_token=%s AND status='ASSIGNED' RETURNING id",
                (job_execution_id, assignment_token),
            )
            if cur.fetchone() is None:
                log.warn("build execution not claimable", job_execution_id=job_execution_id)
                return
            cur.execute("UPDATE job_executions SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=%s", (job_execution_id,))
        self.conn.commit()

        ctx = self._load(dataset_id)
        staging = os.path.join(ctx["root_host"], ".building", dataset_id)
        with joblog.Capture(self.storage, self.cfg.pg_conninfo(), self.cfg.consumer, job_execution_id):
            try:
                result = self._materialise(ctx, staging, job_execution_id)
                self._complete(ctx, dataset_id, job_execution_id, correlation_id, result)
            except BuildError as be:
                shutil.rmtree(staging, ignore_errors=True)
                self._fail(ctx, dataset_id, job_execution_id, correlation_id, be.code, be.message)
            except Exception as e:  # noqa: BLE001
                shutil.rmtree(staging, ignore_errors=True)
                self._fail(ctx, dataset_id, job_execution_id, correlation_id, "DATASET_BUILD_FAILED", str(e)[:500])

    def _load(self, dataset_id: str) -> dict:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT d.id, d.name, d.task_type, d.dataset_type_id, d.source_dataset_ids, "
                "d.split_strategy, d.random_seed, d.train_ratio, d.val_ratio, d.test_ratio, "
                "d.storage_mode, d.same_split_targets, d.created_by_user_id, "
                # training_dataset_path, not model_path: built datasets belong under the
                # type's training-dataset root. 054 dropped the old ULTRALYTICS_DATASET
                # storage root and this fell back to the Model Root by mistake.
                "dt.training_dataset_path "
                "FROM training_datasets d JOIN dataset_types dt ON dt.id=d.dataset_type_id WHERE d.id=%s",
                (dataset_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise BuildError("TRAINING_DATASET_NOT_FOUND", "training dataset not found")
            (did, name, task_type, dataset_type_id, source_ids, split_strategy, random_seed,
             train_ratio, val_ratio, test_ratio, storage_mode, same_split_targets, created_by,
             root_host) = row
            if not root_host:
                raise BuildError("TRAINING_DATASET_ROOT_NOT_FOUND",
                                 "dataset type has no training_dataset_path configured")

            source_ids = source_ids or []

            # Resolve sources
            sources = []
            all_classes = {}
            for sid in source_ids:
                cur.execute(
                    "SELECT sd.id, sd.relative_path, sd.images_relative_path, sd.labels_relative_path, "
                    "sd.allow_subdirectories, sc.id, sc.content_hash, sc.manifest_artifact_id "
                    "FROM source_datasets sd "
                    "LEFT JOIN source_dataset_scans sc ON sc.id=sd.latest_scan_id "
                    "WHERE sd.id=%s",
                    (str(sid),),
                )
                sr = cur.fetchone()
                if sr is None:
                    raise BuildError("SOURCE_DATASET_NOT_FOUND", f"source dataset {sid} not found")
                (src_id, rel, images_rel, labels_rel, allow_subdirs,
                 scan_id, content_hash, manifest_artifact_id) = sr
                if scan_id is None or manifest_artifact_id is None:
                    raise BuildError("SOURCE_DATASET_NOT_READY", f"source {sid} has no completed scan")

                # Get manifest key for artifact download
                cur.execute("SELECT object_key FROM artifacts WHERE id=%s", (manifest_artifact_id,))
                mrow = cur.fetchone()
                if mrow is None:
                    raise BuildError("DATASET_BUILD_FAILED", f"scan manifest artifact missing for source {src_id}")

                images_dir = os.path.join(rel, images_rel)
                labels_dir = os.path.join(rel, labels_rel)

                # Collect classes from this source's scan
                cur.execute(
                    "SELECT class_index, class_name FROM source_dataset_classes "
                    "WHERE scan_id=%s ORDER BY class_index",
                    (str(scan_id),),
                )
                for cr in cur.fetchall():
                    if cr[0] not in all_classes:
                        all_classes[cr[0]] = cr[1]

                sources.append({
                    "source_dataset_id": str(src_id), "source_scan_id": str(scan_id),
                    "images_dir": images_dir, "labels_dir": labels_dir,
                    "allow_subdirs": bool(allow_subdirs), "content_hash": content_hash or "",
                    "manifest_key": mrow[0],
                })

            classes = [{"index": idx, "name": name} for idx, name in sorted(all_classes.items())]

            # Generate relative_path for output. psycopg hands back a uuid.UUID for
            # a uuid column, so it has to be stringified before slicing.
            safe_name = name.lower().replace(" ", "-").replace("/", "-")[:40]
            relative_path = f"datasets/{safe_name}-{str(did)[:8]}"

        return {
            "dataset_id": str(did), "relative_path": relative_path,
            "storage_mode": storage_mode, "split_strategy": split_strategy,
            "random_seed": random_seed, "ratios": {"train": float(train_ratio), "val": float(val_ratio), "test": float(test_ratio)},
            "same_split_targets": same_split_targets, "created_by": created_by, "ds_name": name,
            "task_type": task_type, "root_host": root_host,
            "classes": classes, "sources": sources,
        }

    def _collect_pairs(self, ctx: dict) -> list:
        pairs = []
        for src in ctx["sources"]:
            current = scanner.compute_content_hash(src["images_dir"], src["labels_dir"], src["allow_subdirs"])
            if current != src["content_hash"]:
                raise BuildError("DATASET_SOURCE_CHANGED_SINCE_SCAN",
                                 f"source {src['source_dataset_id']} changed since scan; rescan required")
            manifest = json.loads(self.storage.get_bytes(src["manifest_key"]))
            for item in manifest.get("items", []):
                img_rel = item["image_relative_path"]
                lbl_rel = item["label_relative_path"]
                img_abs = os.path.join(src["images_dir"], img_rel)
                lbl_abs = os.path.join(src["labels_dir"], lbl_rel)
                if not os.path.isfile(img_abs) or not os.path.isfile(lbl_abs):
                    raise BuildError("DATASET_SOURCE_CHANGED_SINCE_SCAN",
                                     f"missing file for {img_rel} in source {src['source_dataset_id']}")
                pair_key = f"{src['source_dataset_id']}:{img_rel}"
                stem = os.path.splitext(os.path.basename(img_rel))[0]
                ext = os.path.splitext(img_rel)[1].lower()
                phash = hashlib.sha1(pair_key.encode("utf-8")).hexdigest()[:12]
                target_stem = f"{phash}_{stem}"
                pairs.append({
                    "pair_key": pair_key, "source_dataset_id": src["source_dataset_id"],
                    "img_abs": img_abs, "lbl_abs": lbl_abs,
                    "src_img_rel": img_rel, "src_lbl_rel": lbl_rel,
                    "img_name": f"{target_stem}{ext}", "lbl_name": f"{target_stem}.txt",
                })
        return pairs

    def _assign_splits(self, ctx: dict, pairs: list) -> dict:
        counts = {s: 0 for s in SPLITS}
        if ctx["split_strategy"] == "RANDOM":
            pairs.sort(key=lambda p: p["pair_key"])
            random.Random(int(ctx["random_seed"] or 0)).shuffle(pairs)
            counts = _largest_remainder(len(pairs), ctx["ratios"])
            if all(counts[s] == 0 for s in SPLITS):
                raise BuildError("DATASET_SPLIT_EMPTY", "no items remain after split allocation")
            i = 0
            for s in SPLITS:
                for _ in range(counts[s]):
                    pairs[i]["splits"] = [s]
                    i += 1
        elif ctx["split_strategy"] == "SAME":
            # Despite the name, nothing about the source's own layout is read — a source
            # dataset is a flat images/ + labels/ pair and has no split structure to
            # preserve. Every item is placed in every requested split, so selecting both
            # train and val yields two identical sets. The UI labels this "No split".
            targets = ctx["same_split_targets"] or ["train", "val"]
            targets = [t for t in targets if t in SPLITS]
            if not targets:
                raise BuildError("DATASET_SPLIT_INVALID", "no valid same_split_targets")
            for p in pairs:
                p["splits"] = list(targets)
            for s in targets:
                counts[s] = len(pairs)
        else:
            raise BuildError("DATASET_SPLIT_INVALID", f"unsupported split strategy {ctx['split_strategy']}")
        if len(pairs) == 0:
            raise BuildError("DATASET_SPLIT_EMPTY", "no valid pairs to build")
        return counts

    def _materialise(self, ctx: dict, staging: str, job_execution_id: str) -> dict:
        pairs = self._collect_pairs(ctx)
        joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 20,
                        f"Collected {len(pairs)} image/label pairs from {len(ctx['sources'])} sources")
        counts = self._assign_splits(ctx, pairs)
        joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 30, "Split assigned")
        present = [s for s in SPLITS if counts[s] > 0]

        shutil.rmtree(staging, ignore_errors=True)
        for s in present:
            os.makedirs(os.path.join(staging, "images", s), exist_ok=True)
            os.makedirs(os.path.join(staging, "labels", s), exist_ok=True)

        expected_fields = scanner.FIELD_COUNT.get(ctx["task_type"])
        stripped_label_count = 0
        manifest_items = []
        for idx, p in enumerate(pairs):
            for s in p["splits"]:
                dst_img = os.path.join(staging, "images", s, p["img_name"])
                dst_lbl = os.path.join(staging, "labels", s, p["lbl_name"])
                _copy_or_link(p["img_abs"], dst_img, ctx["storage_mode"])
                if _write_label(p["lbl_abs"], dst_lbl, ctx["storage_mode"], expected_fields):
                    stripped_label_count += 1
                manifest_items.append({
                    "source_dataset_id": p["source_dataset_id"],
                    "source_image_relative_path": p["src_img_rel"],
                    "source_label_relative_path": p["src_lbl_rel"],
                    "target_split": s,
                    "target_image_relative_path": f"images/{s}/{p['img_name']}",
                    "target_label_relative_path": f"labels/{s}/{p['lbl_name']}",
                })
            if idx % 500 == 0:
                joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 30 + 60 * (idx + 1) / len(pairs),
                                f"Materialising item {idx + 1}/{len(pairs)}")

        dataset_root = os.path.join(ctx["root_host"], ctx["relative_path"])
        data_yaml = {"path": dataset_root}
        for s in present:
            data_yaml[s] = f"images/{s}"
        data_yaml["names"] = {c["index"]: c["name"] for c in ctx["classes"]}
        data_yaml_bytes = yaml.safe_dump(data_yaml, allow_unicode=True, sort_keys=False).encode("utf-8")
        with open(os.path.join(staging, "data.yaml"), "wb") as f:
            f.write(data_yaml_bytes)
        joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 95, "data.yaml written")

        manifest = {
            "dataset_id": ctx["dataset_id"], "classes": ctx["classes"],
            "task_type": ctx["task_type"], "split_strategy": ctx["split_strategy"], "random_seed": ctx["random_seed"],
            "storage_mode": ctx["storage_mode"],
            "sources": [{"source_dataset_id": s["source_dataset_id"], "source_scan_id": s["source_scan_id"],
                          "content_hash": s["content_hash"]} for s in ctx["sources"]],
            "counts": counts, "stripped_confidence_label_count": stripped_label_count,
            "items": manifest_items,
        }
        if stripped_label_count:
            log.info("stripped confidence column from labels", dataset_id=ctx["dataset_id"],
                     label_file_count=stripped_label_count)
        manifest_bytes = json.dumps(manifest, ensure_ascii=False).encode("utf-8")

        self._validate(staging, present, manifest_items, ctx, data_yaml_bytes)

        target_final = os.path.join(ctx["root_host"], ctx["relative_path"])
        if os.path.exists(target_final):
            raise BuildError("DATASET_TARGET_ALREADY_EXISTS", f"target already exists: {ctx['relative_path']}")
        os.makedirs(os.path.dirname(target_final), exist_ok=True)
        os.rename(staging, target_final)

        return {"counts": counts, "class_count": len(ctx["classes"]),
                "data_yaml_bytes": data_yaml_bytes, "manifest_bytes": manifest_bytes}

    def _validate(self, staging: str, present: list, items: list, ctx: dict, data_yaml_bytes: bytes) -> None:
        staging_real = os.path.realpath(staging)
        for it in items:
            for rel in (it["target_image_relative_path"], it["target_label_relative_path"]):
                full = os.path.join(staging, rel)
                if not os.path.isfile(full):
                    raise BuildError("DATASET_BUILD_FAILED", f"expected build file missing: {rel}")
                if os.path.islink(full):
                    raise BuildError("DATASET_BUILD_FAILED", f"symlink not allowed: {rel}")
                if not os.path.realpath(full).startswith(staging_real + os.sep):
                    raise BuildError("DATASET_BUILD_FAILED", f"file escapes version root: {rel}")
        try:
            loaded = yaml.safe_load(data_yaml_bytes)
        except Exception as e:  # noqa: BLE001
            raise BuildError("DATASET_DATA_YAML_INVALID", str(e)[:200])
        if not loaded.get("path") or len(loaded.get("names", {})) != len(ctx["classes"]):
            raise BuildError("DATASET_DATA_YAML_INVALID", "data.yaml path/names inconsistent")

    def _upload(self, dataset_id: str, result: dict) -> dict:
        dy_id = str(uuid.uuid4())
        dy = self.storage.put_bytes(
            f"artifacts/dataset/{dataset_id}/{dy_id}/data.yaml", result["data_yaml_bytes"], "application/x-yaml")
        dy["artifact_id"] = dy_id
        mf_id = str(uuid.uuid4())
        mf = self.storage.put_bytes(
            f"artifacts/dataset/{dataset_id}/{mf_id}/manifest.json", result["manifest_bytes"], "application/json")
        mf["artifact_id"] = mf_id
        return {"data_yaml": dy, "manifest": mf}

    def _complete(self, ctx, dataset_id, job_execution_id, correlation_id, result) -> None:
        up = self._upload(dataset_id, result)
        counts = result["counts"]
        with self.conn.cursor() as cur:
            for kind, aid, info, mime, fname, primary in (
                ("DATA_YAML", up["data_yaml"]["artifact_id"], up["data_yaml"], "application/x-yaml", "data.yaml", True),
                ("DATASET_MANIFEST", up["manifest"]["artifact_id"], up["manifest"], "application/json", "manifest.json", False),
            ):
                cur.execute(
                    "INSERT INTO artifacts (id, owner_type_code, owner_id, artifact_type_code, source_execution_id, "
                    "status, bucket_name, object_key, filename, mime_type, file_size_bytes, checksum, is_primary, "
                    "created_by_actor_type, created_by_actor_ref, verified_at) "
                    "VALUES (%s,'TRAINING_DATASET',%s,%s,%s,'VERIFIED',%s,%s,%s,%s,%s,%s,%s,'WORKER',%s,now())",
                    (aid, dataset_id, kind, job_execution_id, info["bucket"], info["object_key"], fname, mime,
                     info["size"], info["checksum"], primary, self.cfg.consumer),
                )
            cur.execute(
                "UPDATE training_datasets SET status='READY', ready_at=now(), build_finished_at=now(), "
                "train_count=%s, val_count=%s, test_count=%s, class_count=%s, "
                "data_yaml_artifact_id=%s, manifest_artifact_id=%s, relative_path=%s WHERE id=%s",
                (counts["train"], counts["val"], counts["test"], result["class_count"],
                 up["data_yaml"]["artifact_id"], up["manifest"]["artifact_id"], ctx["relative_path"], dataset_id),
            )
            cur.execute(
                "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                "result, correlation_id, metadata) VALUES ('WORKER',%s,'TRAINING_DATASET_BUILD_COMPLETED',"
                "'TRAINING_DATASET',%s,'SUCCESS',%s,%s) RETURNING id",
                (self.cfg.consumer, dataset_id, correlation_id,
                 json.dumps({"train": counts["train"], "val": counts["val"], "test": counts["test"],
                             "class_count": result["class_count"]})),
            )
            audit_id = cur.fetchone()[0]
            if ctx["created_by"]:
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'SUCCESS','Dataset Build Completed',%s,'TRAINING_DATASET',%s)",
                    (audit_id, ctx["created_by"],
                     f"Build for \"{ctx['ds_name']}\" completed "
                     f"(train={counts['train']}, val={counts['val']}, test={counts['test']}).", dataset_id),
                )
            cur.execute("UPDATE job_executions SET status='SUCCEEDED', finished_at=now() WHERE id=%s", (job_execution_id,))
        self.conn.commit()
        joblog.progress(self.cfg.pg_conninfo(), job_execution_id, 100,
                        f"Dataset build completed (train={counts['train']}, val={counts['val']}, test={counts['test']})")
        log.info("dataset build completed", dataset_id=dataset_id,
                 train=counts["train"], val=counts["val"], test=counts["test"])

    def _fail(self, ctx, dataset_id, job_execution_id, correlation_id, code, message) -> None:
        self.conn.rollback()
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE training_datasets SET status='INVALID', build_finished_at=now(), "
                "failure_code=%s, failure_message=%s WHERE id=%s",
                (code, message[:1000], dataset_id),
            )
            cur.execute(
                "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                "result, correlation_id, error_code, error_message) VALUES ('WORKER',%s,'TRAINING_DATASET_BUILD_FAILED',"
                "'TRAINING_DATASET',%s,'FAILURE',%s,%s,%s) RETURNING id",
                (self.cfg.consumer, dataset_id, correlation_id, code, message[:1000]),
            )
            audit_id = cur.fetchone()[0]
            if ctx and ctx.get("created_by"):
                cur.execute(
                    "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
                    "resource_type_code, resource_id) VALUES (%s,%s,'ERROR','Dataset Build Failed',%s,'TRAINING_DATASET',%s)",
                    (audit_id, ctx["created_by"], f"Build for \"{ctx['ds_name']}\" failed: {code}.", dataset_id),
                )
            cur.execute("UPDATE job_executions SET status='FAILED', finished_at=now(), error_code=%s, error_message=%s WHERE id=%s",
                        (code, message[:1000], job_execution_id))
        self.conn.commit()
        log.error("dataset build failed", dataset_id=dataset_id, error_code=code, detail=message[:200])
