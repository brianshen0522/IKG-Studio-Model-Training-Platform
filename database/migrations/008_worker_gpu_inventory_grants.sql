-- GPU telemetry on the dashboard needs two things that 001 did not allow.
--
-- 1) The training-worker now registers its physical GPU inventory into `worker_gpus`
--    on every heartbeat (stable gpu_uuid identity, so a job can be attributed to the
--    card it ran on). 001 granted worker_role SELECT only, on the assumption that the
--    scheduler would populate the table; nothing ever did, and only the worker can
--    actually enumerate its own devices via NVML. Without INSERT/UPDATE the heartbeat
--    fails with "permission denied for table worker_gpus".
GRANT INSERT, UPDATE ON TABLE app.worker_gpus TO worker_role;

-- 2) `job_execution_gpus` rows are claimed when a run starts and released when it
--    ends. worker_role already has SELECT/INSERT/UPDATE, which covers both, so no
--    further grant is needed there — recorded here only to note it was checked.

-- The inventory upsert keys on gpu_uuid alone: a GPU UUID is globally unique, and a
-- card physically moved to another host must update its existing row rather than
-- create a second one (worker_id is part of the row, not its identity). The existing
-- uq_worker_gpu_uuid is UNIQUE (worker_id, gpu_uuid), which cannot serve as the
-- ON CONFLICT target for that upsert and would also permit the duplicate-on-move it
-- was presumably meant to prevent.
ALTER TABLE app.worker_gpus DROP CONSTRAINT IF EXISTS uq_worker_gpu_uuid;
ALTER TABLE app.worker_gpus ADD CONSTRAINT uq_worker_gpu_uuid UNIQUE (gpu_uuid);

-- `uq_worker_gpu_index` stays UNIQUE (worker_id, gpu_index) — a CUDA index is only
-- unique within one host — but it must become DEFERRABLE. The heartbeat upserts all of a
-- host's cards in one statement, and if the driver reports them in a different order than
-- last time (CUDA_DEVICE_ORDER, a card added or removed, PCI renumbering) the indices
-- effectively swap. Postgres checks a non-deferrable unique constraint per row, so the
-- first updated row transiently collides with the second row's old index and the whole
-- heartbeat fails with 'duplicate key value violates unique constraint'. Deferring the
-- check to COMMIT validates the set-level result instead of each intermediate row.
-- (Verified against a real Postgres: the index swap fails before this change, passes after.)
ALTER TABLE app.worker_gpus DROP CONSTRAINT IF EXISTS uq_worker_gpu_index;
ALTER TABLE app.worker_gpus
    ADD CONSTRAINT uq_worker_gpu_index UNIQUE (worker_id, gpu_index) DEFERRABLE INITIALLY IMMEDIATE;
