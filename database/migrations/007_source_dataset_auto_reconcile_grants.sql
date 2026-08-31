-- The dataset-worker's directory reindex now reconciles registered source datasets
-- whose folder disappeared from disk: ones referenced by a training dataset are
-- auto-archived, unreferenced ones are purged (scan history first, then the row —
-- both FK directions are ON DELETE RESTRICT). worker_role so far could only
-- INSERT/UPDATE these tables.
GRANT DELETE ON TABLE app.source_dataset_scans TO worker_role;
GRANT DELETE ON TABLE app.source_datasets TO worker_role;

-- The scheduler now dispatches periodic directory reindexes (so the reconcile above
-- happens without anyone pressing Rescan) and needs to upsert the per-type reindex
-- bookkeeping row the same way the API's dispatch does.
GRANT SELECT,INSERT,UPDATE ON TABLE app.dataset_type_reindexes TO scheduler_role;
