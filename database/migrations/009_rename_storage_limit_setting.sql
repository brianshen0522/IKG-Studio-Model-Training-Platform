-- Artifacts are served by SeaweedFS now, so the setting key naming MinIO is
-- wrong. Rename it to storage_limit_bytes, which describes what it limits
-- without naming the implementation.
--
-- Written as an UPDATE of the existing row rather than a delete-and-insert so
-- that a deployment which already raised its limit keeps that value. The WHERE
-- guard makes a re-run a no-op, and the second statement covers a fresh
-- database where 001 seeded the old key and this file is applied right after.

UPDATE app.system_settings
SET setting_key = 'storage_limit_bytes',
    description = 'Maximum allowed object storage limit in bytes (0 for unlimited)'
WHERE setting_key = 'storage_minio_limit_bytes'
  AND NOT EXISTS (
    SELECT 1 FROM app.system_settings WHERE setting_key = 'storage_limit_bytes'
  );

-- If both keys somehow exist, drop the stale one; the new key is authoritative.
DELETE FROM app.system_settings
WHERE setting_key = 'storage_minio_limit_bytes'
  AND EXISTS (
    SELECT 1 FROM app.system_settings WHERE setting_key = 'storage_limit_bytes'
  );
