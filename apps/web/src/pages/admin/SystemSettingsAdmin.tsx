import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGetList, apiSend } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import { SkeletonLoader } from '../../components/SkeletonLoader';
import { EmptyState } from '../../components/EmptyState';

interface SettingRow {
  setting_key: string;
  value: unknown;
  description: string | null;
  is_secret: boolean;
  updated_at: string;
}

type ValueType = 'boolean' | 'number' | 'string';

/** Ordered sections; anything unmatched falls into "Other" at the end. */
const GROUPS: { title: string; prefixes: string[] }[] = [
  { title: 'Authentication', prefixes: ['auth_'] },
  { title: 'Models', prefixes: ['model_'] },
  { title: 'Datasets', prefixes: ['dataset_type_', 'managed_dataset_'] },
  { title: 'Workers & queue', prefixes: ['worker_', 'queue_'] },
  { title: 'Storage', prefixes: ['storage_', 'workspace_'] },
];

const typeOf = (v: unknown): ValueType =>
  typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'string';

const BYTE_UNITS = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 } as const;
type ByteUnit = keyof typeof BYTE_UNITS;

export function SystemSettingsAdmin() {
  const queryClient = useQueryClient();
  const csrfToken = useAuthStore((s) => s.csrfToken);
  // Only keys the user actually touched appear here, so "dirty" is exact rather than a
  // comparison against a re-serialised copy of every row.
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [byteUnits, setByteUnits] = useState<Record<string, ByteUnit>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-system-settings'],
    queryFn: () => apiGetList<SettingRow>('/admin/system-settings'),
  });

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      apiSend('PATCH', `/admin/system-settings/${encodeURIComponent(key)}`, { value }, csrfToken),
  });

  function commit(row: SettingRow) {
    const key = row.setting_key;
    const raw = edits[key];
    const value = typeOf(row.value) === 'number' ? Number(raw)
      : typeOf(row.value) === 'boolean' ? Boolean(raw)
      : String(raw ?? '');
    setSavingKey(key);
    setFailed((f) => { const { [key]: _drop, ...rest } = f; return rest; });
    save.mutate({ key, value }, {
      onSuccess: () => {
        setEdits((e) => { const { [key]: _drop, ...rest } = e; return rest; });
        queryClient.invalidateQueries({ queryKey: ['admin-system-settings'] });
      },
      onError: (e) => setFailed((f) => ({ ...f, [key]: (e as Error).message })),
      onSettled: () => setSavingKey(null),
    });
  }

  const revert = (key: string) => {
    setEdits((e) => { const { [key]: _drop, ...rest } = e; return rest; });
    setFailed((f) => { const { [key]: _drop, ...rest } = f; return rest; });
  };

  function control(row: SettingRow) {
    const key = row.setting_key;
    const val = key in edits ? edits[key] : row.value;
    const set = (v: unknown) => setEdits((e) => ({ ...e, [key]: v }));

    if (row.is_secret) return <span className="setting-secret">hidden</span>;

    if (typeOf(row.value) === 'boolean') {
      return (
        <label className="switch">
          <input type="checkbox" checked={Boolean(val)} onChange={(e) => set(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">{Boolean(val) ? 'Enabled' : 'Disabled'}</span>
        </label>
      );
    }
    if (typeOf(row.value) === 'number') {
      const n = Number(val);
      if (key.endsWith('_bytes')) {
        const unit = byteUnits[key] ?? 'GB';
        const displayVal = Number.isFinite(n) ? n / BYTE_UNITS[unit] : n;
        return (
          <div className="setting-input">
            <input
              type="number"
              value={Number.isFinite(displayVal) ? String(displayVal) : String(val ?? '')}
              onChange={(e) => set(String(Number(e.target.value) * BYTE_UNITS[unit]))}
            />
            <select
              className="setting-unit-select"
              value={unit}
              onChange={(e) => setByteUnits((u) => ({ ...u, [key]: e.target.value as ByteUnit }))}
            >
              {Object.keys(BYTE_UNITS).map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        );
      }
      return (
        <div className="setting-input">
          <input type="number" value={String(val ?? '')} onChange={(e) => set(e.target.value)} />
        </div>
      );
    }
    return (
      <div className="setting-input">
        <input type="text" value={String(val ?? '')} onChange={(e) => set(e.target.value)}
          placeholder="not set" spellCheck={false} />
      </div>
    );
  }

  const rows = data?.data ?? [];
  const grouped = GROUPS
    .map((g) => ({ title: g.title, rows: rows.filter((r) => g.prefixes.some((p) => r.setting_key.startsWith(p))) }))
    .concat([{
      title: 'Other',
      rows: rows.filter((r) => !GROUPS.some((g) => g.prefixes.some((p) => r.setting_key.startsWith(p)))),
    }])
    .filter((g) => g.rows.length > 0);

  const dirtyCount = Object.keys(edits).length;

  return (
    <section className="page">
      <header className="page-head">
        <h2>System Settings</h2>
        {dirtyCount > 0 && (
          <span className="badge badge-amber">{dirtyCount} unsaved</span>
        )}
      </header>
      <p className="page-sub">
        Applied platform-wide. Changes take effect on the next operation that reads the setting.
      </p>

      {isLoading && <SkeletonLoader rows={6} cols={2} />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && rows.length === 0 && <EmptyState message="No system settings." />}

      {grouped.map((g) => (
        <div className="settings-group" key={g.title}>
          <h3 className="settings-group-head">{g.title}</h3>
          {g.rows.map((r) => {
            const key = r.setting_key;
            const dirty = key in edits;
            return (
              <div className={`setting-row${dirty ? ' is-dirty' : ''}`} key={key}>
                <div className="setting-info">
                  <span className="setting-desc">{r.description || key}</span>
                  <code className="setting-key">{key}</code>
                  {failed[key] && <span className="setting-error">{failed[key]}</span>}
                </div>
                <div className="setting-control">{control(r)}</div>
                {/* Save appears only for the row being edited — sixteen permanent Save
                    buttons was noise, and a shared isPending flag made them all read
                    "Saving…" whenever any one row was written. */}
                <div className="setting-actions">
                  {dirty && (
                    <>
                      <button className="btn btn-sm btn-ghost" onClick={() => revert(key)}
                        disabled={savingKey === key}>
                        Revert
                      </button>
                      <button className="btn btn-sm btn-primary" onClick={() => commit(r)}
                        disabled={savingKey === key}>
                        {savingKey === key ? 'Saving…' : 'Save'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
