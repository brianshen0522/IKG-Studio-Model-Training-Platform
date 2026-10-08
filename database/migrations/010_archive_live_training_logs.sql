-- Retire the TRAIN_LOG rows the training worker used to register for its live
-- log (artifacts/training-job/<job>/live/training.log). The worker inserted the
-- row on the first epoch and then kept overwriting the object behind it, so the
-- row's size and checksum describe the first epoch's log while the object holds
-- the whole run: a VERIFIED artifact whose content no longer matches its record.
-- The worker now keeps its live log outside the artifacts prefix with no row.
--
-- Only rows whose job also has a final TRAIN_LOG are archived. That one was
-- written once at the end of the run, so it is the job's real log, and the
-- live row is a stale duplicate. A job without one (it failed or was stopped
-- before the worker wrote a final log for those cases too) keeps its live row,
-- because that object is the only log it has.
--
-- Content columns and objects are left alone: trg_artifacts_content_immutable
-- forbids changing the former, and artifacts are never deleted (AGENTS.md rule
-- 3). Archiving takes the row out of the artifact listings, which only return
-- STORED and VERIFIED, and out of reconciliations that skip archived rows.
-- Re-running is a no-op: archived rows no longer match the status filter.

UPDATE app.artifacts AS live
SET status = 'ARCHIVED',
    archived_at = now(),
    metadata = live.metadata || jsonb_build_object(
        'archived_reason',
        'live training log: object was overwritten after this row was written, so '
        'file_size_bytes and checksum describe only the first epoch; the job''s '
        'final TRAIN_LOG is the authoritative log'
    )
WHERE live.artifact_type_code = 'TRAIN_LOG'
  AND live.owner_type_code = 'TRAINING_JOB'
  AND live.object_key LIKE 'artifacts/training-job/%/live/training.log'
  AND live.status <> 'ARCHIVED'
  AND EXISTS (
    SELECT 1
    FROM app.artifacts AS final
    WHERE final.owner_type_code = 'TRAINING_JOB'
      AND final.owner_id = live.owner_id
      AND final.artifact_type_code = 'TRAIN_LOG'
      AND final.object_key NOT LIKE '%/live/training.log'
      AND final.status IN ('STORED', 'VERIFIED')
  );
