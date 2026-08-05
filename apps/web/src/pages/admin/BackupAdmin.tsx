import { useRef, useState } from 'react';
import { apiSend, readCsrfCookie } from '../../lib/api';

interface BackupCounts {
  users: number;
  dataset_types: number;
  system_settings: number;
  webauthn_credentials: number;
}

export function BackupAdmin() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BackupCounts | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onExport() {
    setExporting(true);
    setError(null);
    setResult(null);
    try {
      const csrf = readCsrfCookie();
      const payload = await apiSend<unknown>('POST', '/admin/backup/export', {}, csrf);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ikg-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  function onFileChange() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(reader.result));
      } catch {
        setError('File is not valid JSON.');
        return;
      }
      if (!window.confirm(
        'Importing overwrites all users, dataset types and system settings with the contents of this file.\n\n' +
        'This can only run on a fresh/empty system. Continue?',
      )) {
        if (fileRef.current) fileRef.current.value = '';
        return;
      }
      setImporting(true);
      try {
        const csrf = readCsrfCookie();
        const counts = await apiSend<BackupCounts>('POST', '/admin/backup/import', payload, csrf);
        setResult(counts);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setImporting(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    };
    reader.readAsText(file);
  }

  return (
    <section className="page">
      <header className="page-head">
        <h2>Backup &amp; Restore</h2>
      </header>

      <p className="muted-text">
        Export downloads a JSON file containing all users (incl. password hashes &amp; passkeys),
        dataset types and system settings (incl. secret values). Import restores the file by
        overwriting these tables; it is only supported on a fresh/empty system.
      </p>

      <div className="admin-backup-actions">
        <button className="btn" onClick={onExport} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export backup'}
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={importing}>
          {importing ? 'Importing…' : 'Import backup'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={onFileChange}
        />
      </div>

      {error && <p className="form-error">{error}</p>}
      {result && (
        <p className="form-success">
          Import complete — {result.users} users, {result.dataset_types} dataset types,
          {result.system_settings} system settings, {result.webauthn_credentials} passkeys.
        </p>
      )}
    </section>
  );
}
