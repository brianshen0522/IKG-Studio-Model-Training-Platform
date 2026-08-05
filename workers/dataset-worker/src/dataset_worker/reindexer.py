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
