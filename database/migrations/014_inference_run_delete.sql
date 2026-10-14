-- Deleting inference runs (docs/inference-delete-plan.md). A run started with
-- the wrong model or datasets could not be removed, and its diffs and ZIP kept
-- their space.
--
-- The run row is soft-deleted: job_executions, audit rows and notifications
-- refer to it by id and must keep resolving. Its diff rows and its ZIP (the
-- artifact row and the object) are deleted outright by the backend; that is the
-- space the user is after. The ZIP is a local exception to AGENTS.md rule 3,
-- the same one ModelsService.deleteModel makes for a model's conversions.

-- Not used in this file: a value added inside a transaction cannot be used in
-- the same transaction, which is also why the index below keys on deleted_at.
ALTER TYPE app.inference_run_status ADD VALUE IF NOT EXISTS 'DELETED';

ALTER TABLE app.inference_runs
    ADD COLUMN deleted_at timestamp with time zone,
    ADD COLUMN deleted_by_user_id uuid,
    ADD CONSTRAINT inference_runs_deleted_by_user_id_fkey
        FOREIGN KEY (deleted_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

-- A deleted run's name is free again: the point of deleting a run started with
-- the wrong options is often to start it again, under the name it should have had.
DROP INDEX app.uq_inference_runs_dataset_type_name;
CREATE UNIQUE INDEX uq_inference_runs_dataset_type_name
    ON app.inference_runs (dataset_type_id, lower(name)) WHERE deleted_at IS NULL;
