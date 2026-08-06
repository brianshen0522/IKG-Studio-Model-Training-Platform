-- Scheduler reconcile needs to fail lost dataset scans/builds/ingests and reset
-- their business entities (source dataset -> REGISTERED, training dataset ->
-- INVALID, ingest task -> FAILED). These reconcile paths were added after the
-- original role grants in 001, which only gave scheduler_role SELECT on these
-- tables, so lost-job cleanup has been failing with
-- "permission denied for table ..." on every tick.
GRANT UPDATE ON TABLE app.source_dataset_scans TO scheduler_role;
GRANT UPDATE ON TABLE app.source_datasets TO scheduler_role;
GRANT UPDATE ON TABLE app.training_datasets TO scheduler_role;
GRANT UPDATE ON TABLE app.model_ingest_tasks TO scheduler_role;
