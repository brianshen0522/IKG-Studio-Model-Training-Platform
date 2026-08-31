"""Dataset directory reindex.

Background walk of a dataset type's effective dataset_path that fills the
dataset_directory_index table, so browseByType() / available() become pure DB reads
instead of a synchronous CIFS walk that blocks the API for seconds per type.

Mirrors discoverDatasetFolders() depth-bounded logic (images/ + labels/ marks a dataset
folder; descent stops there), but runs in the worker with no time budget. Heartbeats
dataset_type_reindexes every 50 folders so a long walk over a CIFS mount does not look
stale to the reconcile loop (which only watches job_executions anyway, but the column
is still useful to the UI as a liveness signal).
"""
import json
import os

from . import log

MAX_DEPTH = 4
HEARTBEAT_EVERY = 50


def _listdir(path):
    try:
        return os.listdir(path)
    except OSError:
        return []


def _discover(root, on_progress=None):
    """Return [(sub_path, image_count, label_count), ...] for dataset folders under root."""
    out = []
    visited = [0]

    def walk(dir_, rel, depth):
        if depth > MAX_DEPTH:
            return
        try:
            entries = os.scandir(dir_)
        except OSError:
            return
        dirs = []
        names = set()
        with entries:
            for e in entries:
                if e.name.startswith("."):
                    continue
                names.add(e.name)
                if e.is_dir(follow_symlinks=False) and not e.is_symlink():
                    dirs.append(e.name)
        if "images" in names and "labels" in names:
            out.append((rel, len(_listdir(os.path.join(dir_, "images"))),
                        len(_listdir(os.path.join(dir_, "labels")))))
            return  # a dataset folder does not contain further datasets
        for d in dirs:
            visited[0] += 1
            if on_progress and visited[0] % HEARTBEAT_EVERY == 0:
                on_progress()
            child = os.path.join(dir_, d)
            child_rel = f"{rel}/{d}" if rel else d
            walk(child, child_rel, depth + 1)

    walk(root, "", 0)
    return out


class Reindexer:
    def __init__(self, conn, cfg) -> None:
        self.conn = conn
        self.cfg = cfg

    def run(self, dataset_type_id, correlation_id):
        with self.conn.cursor() as cur:
            # Resolve effective dataset_path walking up the parent chain, mirroring
            # DatasetTypesTreeService.effectiveBasePath. Read here (not passed in the
            # payload) so a concurrent rename cannot point the walk at a stale path.
            cur.execute(
                "WITH RECURSIVE anc AS ("
                " SELECT id, parent_id, dataset_path, 0 AS depth FROM dataset_types WHERE id=%s"
                " UNION ALL"
                " SELECT p.id, p.parent_id, p.dataset_path, a.depth+1"
                " FROM dataset_types p JOIN anc a ON a.parent_id=p.id"
                ") SELECT dataset_path FROM anc WHERE dataset_path IS NOT NULL "
                "ORDER BY depth ASC LIMIT 1",
                (dataset_type_id,),
            )
            row = cur.fetchone()

        if not row:
            self._fail(dataset_type_id, correlation_id, "dataset type has no dataset_path")
            return
        dataset_path = row[0]

        if not os.path.isdir(dataset_path):
            self._fail(dataset_type_id, correlation_id, f"dataset_path not a directory: {dataset_path}")
            return

        # Mark RUNNING (upsert). Reuses the started_at of the previous attempt if the
        # row already exists; what matters is status flips back to RUNNING.
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO dataset_type_reindexes (dataset_type_id, status, correlation_id, started_at, heartbeat_at) "
                "VALUES (%s,'RUNNING',%s,now(),now()) "
                "ON CONFLICT (dataset_type_id) DO UPDATE SET "
                "status='RUNNING', correlation_id=EXCLUDED.correlation_id, "
                "started_at=now(), heartbeat_at=now(), finished_at=NULL, error_message=NULL",
                (dataset_type_id, correlation_id),
            )
        self.conn.commit()
        log.info("reindex start", dataset_type_id=dataset_type_id, root=dataset_path,
                 correlation_id=correlation_id)

        def heartbeat():
            try:
                with self.conn.cursor() as cur:
                    cur.execute(
                        "UPDATE dataset_type_reindexes SET heartbeat_at=now() WHERE dataset_type_id=%s",
                        (dataset_type_id,),
                    )
                self.conn.commit()
            except Exception as e:  # noqa: BLE001
                self.conn.rollback()
                log.warn("reindex heartbeat failed", error=str(e)[:160])

        try:
            folders = _discover(dataset_path, heartbeat)
        except Exception as e:  # noqa: BLE001
            self._fail(dataset_type_id, correlation_id, f"walk failed: {str(e)[:300]}")
            return

        discovered = {f[0]: (f[1], f[2]) for f in folders}
        try:
            with self.conn.cursor() as cur:
                for sub_path, (ic, lc) in discovered.items():
                    cur.execute(
                        "INSERT INTO dataset_directory_index "
                        "(dataset_type_id, sub_path, image_count, label_count, discovered_at) "
                        "VALUES (%s,%s,%s,%s,now()) "
                        "ON CONFLICT (dataset_type_id, sub_path) DO UPDATE SET "
                        "image_count=EXCLUDED.image_count, label_count=EXCLUDED.label_count, "
                        "discovered_at=now()",
                        (dataset_type_id, sub_path, ic, lc),
                    )
                # Drop rows for folders no longer on disk so the index matches reality.
                if discovered:
                    placeholders = ",".join(["%s"] * len(discovered))
                    cur.execute(
                        f"DELETE FROM dataset_directory_index "
                        f"WHERE dataset_type_id=%s AND sub_path NOT IN ({placeholders})",
                        (dataset_type_id, *discovered.keys()),
                    )
                else:
                    cur.execute(
                        "DELETE FROM dataset_directory_index WHERE dataset_type_id=%s",
                        (dataset_type_id,),
                    )
                cur.execute(
                    "UPDATE dataset_type_reindexes "
                    "SET status='COMPLETED', finished_at=now(), heartbeat_at=now() "
                    "WHERE dataset_type_id=%s",
                    (dataset_type_id,),
                )
                cur.execute(
                    "INSERT INTO audit_logs "
                    "(actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                    " result, correlation_id, metadata) "
                    "VALUES ('WORKER',%s,'DATASET_DIRECTORY_REINDEX_COMPLETED','DATASET_TYPE',%s,"
                    " 'SUCCESS',%s,%s)",
                    (self.cfg.consumer, dataset_type_id, correlation_id,
                     json.dumps({"folders": len(folders),
                                 "image_count": sum(f[1] for f in folders)})),
                )
            self.conn.commit()
            log.info("reindex completed", dataset_type_id=dataset_type_id,
                     folders=len(folders), correlation_id=correlation_id)
        except Exception as e:  # noqa: BLE001
            self.conn.rollback()
            self._fail(dataset_type_id, correlation_id, f"index upsert failed: {str(e)[:300]}")
            return

        # With the index now matching disk, reconcile registered rows whose folder is
        # gone: archive the ones training datasets reference, purge the rest. A failure
        # here must not turn the completed reindex into a failed one.
        try:
            self._reconcile_missing(dataset_type_id, dataset_path, discovered, correlation_id)
        except Exception as e:  # noqa: BLE001
            self.conn.rollback()
            log.warn("missing-folder reconcile failed", dataset_type_id=dataset_type_id,
                     error=str(e)[:300])

    def _reconcile_missing(self, dataset_type_id, dataset_path, discovered, correlation_id):
        """Auto-archive / purge registered source datasets whose folder left the disk.

        The walk swallows transient IO errors (an unreadable subtree just yields no
        folders), so absence from ``discovered`` alone is not proof of deletion — each
        candidate's directory is re-checked directly before anything irreversible
        happens. Datasets referenced by any training dataset (archived ones included:
        their manifests cite the source by id) are archived so history stays
        browsable; unreferenced ones are deleted outright, scan history included.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT id, sub_path, name, status, created_by_user_id FROM source_datasets "
                "WHERE dataset_type_id=%s AND archived_at IS NULL",
                (dataset_type_id,),
            )
            rows = cur.fetchall()

        archived = deleted = 0
        for sd_id, sub_path, name, status, created_by in rows:
            rel = sub_path or ""
            if rel in discovered:
                continue
            if status == "SCANNING":
                continue  # archiving is blocked during a scan; the next reindex retries
            if os.path.isdir(os.path.join(dataset_path, rel)):
                continue  # the walk missed it (transient IO error) — leave it alone
            try:
                with self.conn.cursor() as cur:
                    cur.execute(
                        "SELECT 1 FROM training_datasets WHERE source_dataset_ids @> ARRAY[%s]::uuid[] LIMIT 1",
                        (sd_id,),
                    )
                    referenced = cur.fetchone() is not None
                    if referenced:
                        cur.execute(
                            "UPDATE source_datasets SET archived_at=now(), status='ARCHIVED', "
                            "updated_at=now(), row_version=row_version+1 "
                            "WHERE id=%s AND archived_at IS NULL AND status <> 'SCANNING' RETURNING id",
                            (sd_id,),
                        )
                        if cur.fetchone() is None:
                            self.conn.rollback()
                            continue
                        aid = self._audit(cur, "SOURCE_DATASET_AUTO_ARCHIVED", sd_id, correlation_id,
                                          {"sub_path": rel, "reason": "folder missing on disk",
                                           "referenced_by_training_datasets": True})
                        self._notify(cur, aid, created_by, "Source Dataset Archived",
                                     f'"{name}" was archived automatically: its folder is no longer '
                                     "on disk but training datasets were built from it.", sd_id)
                        archived += 1
                    else:
                        # source_datasets.latest_scan_id and source_dataset_scans FK each
                        # other, both RESTRICT — drop the back pointer before the scans.
                        cur.execute("UPDATE source_datasets SET latest_scan_id=NULL WHERE id=%s", (sd_id,))
                        cur.execute("DELETE FROM source_dataset_scans WHERE source_dataset_id=%s", (sd_id,))
                        cur.execute("DELETE FROM source_datasets WHERE id=%s", (sd_id,))
                        aid = self._audit(cur, "SOURCE_DATASET_AUTO_DELETED", sd_id, correlation_id,
                                          {"sub_path": rel, "name": name, "reason": "folder missing on disk",
                                           "referenced_by_training_datasets": False})
                        self._notify(cur, aid, created_by, "Source Dataset Removed",
                                     f'"{name}" was removed automatically: its folder is no longer '
                                     "on disk and no training dataset was built from it.", sd_id)
                        deleted += 1
                self.conn.commit()
            except Exception as e:  # noqa: BLE001
                self.conn.rollback()
                log.warn("reconcile of one source dataset failed",
                         source_dataset_id=str(sd_id), error=str(e)[:200])

        if archived or deleted:
            log.info("missing-folder reconcile", dataset_type_id=dataset_type_id,
                     auto_archived=archived, auto_deleted=deleted)

    def _audit(self, cur, action, resource_id, correlation_id, metadata):
        cur.execute(
            "INSERT INTO audit_logs (actor_type, actor_ref, action_code, resource_type_code, "
            "resource_id, result, correlation_id, metadata) "
            "VALUES ('WORKER',%s,%s,'SOURCE_DATASET',%s,'SUCCESS',%s,%s) RETURNING id",
            (self.cfg.consumer, action, resource_id, correlation_id, json.dumps(metadata)),
        )
        return cur.fetchone()[0]

    def _notify(self, cur, audit_log_id, recipient, title, message, resource_id):
        if not recipient:
            return
        cur.execute(
            "INSERT INTO notifications (audit_log_id, recipient_user_id, severity, title, message, "
            "resource_type_code, resource_id) VALUES (%s,%s,'WARNING',%s,%s,'SOURCE_DATASET',%s)",
            (audit_log_id, recipient, title, message, resource_id),
        )

    def _fail(self, dataset_type_id, correlation_id, message):
        try:
            with self.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO dataset_type_reindexes "
                    "(dataset_type_id, status, correlation_id, started_at, finished_at, error_message) "
                    "VALUES (%s,'FAILED',%s,now(),now(),%s) "
                    "ON CONFLICT (dataset_type_id) DO UPDATE SET "
                    "status='FAILED', correlation_id=EXCLUDED.correlation_id, "
                    "finished_at=now(), error_message=EXCLUDED.error_message",
                    (dataset_type_id, correlation_id, message[:1000]),
                )
                cur.execute(
                    "INSERT INTO audit_logs "
                    "(actor_type, actor_ref, action_code, resource_type_code, resource_id, "
                    " result, correlation_id, error_message) "
                    "VALUES ('WORKER',%s,'DATASET_DIRECTORY_REINDEX_FAILED','DATASET_TYPE',%s,"
                    " 'FAILURE',%s,%s)",
                    (self.cfg.consumer, dataset_type_id, correlation_id, message[:1000]),
                )
            self.conn.commit()
        except Exception as e:  # noqa: BLE001
            self.conn.rollback()
            log.warn("could not record reindex failure", dataset_type_id=dataset_type_id,
                     error=str(e)[:160])
        log.error("reindex failed", dataset_type_id=dataset_type_id,
                  correlation_id=correlation_id, message=message[:200])
