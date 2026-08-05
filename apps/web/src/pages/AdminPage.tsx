import { UsersAdmin } from './admin/UsersAdmin';
import { DatasetTypesAdmin } from './admin/DatasetTypesAdmin';
import { AuditAdmin } from './admin/AuditAdmin';
import { SystemSettingsAdmin } from './admin/SystemSettingsAdmin';
import { WorkersAdmin } from './admin/WorkersAdmin';
import { BackupAdmin } from './admin/BackupAdmin';
import { useUiStore } from '../stores/ui';

export function AdminPage() {
  const tab = useUiStore((s) => s.adminTab);
  const setTab = useUiStore((s) => s.setAdminTab);

  return (
    <section className="page">
      <div className="subnav">
        <button
          className={`subnav-btn${tab === 'users' ? ' active' : ''}`}
          onClick={() => setTab('users')}
        >
          Users
        </button>
        <button
          className={`subnav-btn${tab === 'dataset-types' ? ' active' : ''}`}
          onClick={() => setTab('dataset-types')}
        >
          Dataset Types
        </button>
        <button
          className={`subnav-btn${tab === 'audit' ? ' active' : ''}`}
          onClick={() => setTab('audit')}
        >
          Audit
        </button>
        <button
          className={`subnav-btn${tab === 'settings' ? ' active' : ''}`}
          onClick={() => setTab('settings')}
        >
          System Settings
        </button>
        <button
          className={`subnav-btn${tab === 'workers' ? ' active' : ''}`}
          onClick={() => setTab('workers')}
        >
          Workers
        </button>
        <button
          className={`subnav-btn${tab === 'backup' ? ' active' : ''}`}
          onClick={() => setTab('backup')}
        >
          Backup
        </button>
      </div>

      {tab === 'users' && <UsersAdmin />}
      {tab === 'dataset-types' && <DatasetTypesAdmin />}
      {tab === 'audit' && <AuditAdmin />}
      {tab === 'settings' && <SystemSettingsAdmin />}
      {tab === 'workers' && <WorkersAdmin />}
      {tab === 'backup' && <BackupAdmin />}
    </section>
  );
}
