import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGetList, apiSend } from '../lib/api';
import { useDatasetTypeOptions } from '../lib/options';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { Modal } from './Modal';
import { SkeletonLoader } from './SkeletonLoader';
import { EmptyState } from './EmptyState';

type TaskType = 'DETECT' | 'OBB';
type Step = 'select' | 'review';

interface AvailableItem {
  name: string; path: string; hasImages: boolean; hasLabels: boolean;
  imageCount: number; labelCount: number;
  isRegistered: boolean; registeredId: string | null;
}

interface CreateResult {
  succeeded: { name: string }[];
  failed: { name: string; error: string }[];
}

export function NewSourceDatasetDialog({ onClose }: { onClose: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const { data: datasetTypes, isLoading: dtLoading } = useDatasetTypeOptions();

  const [step, setStep] = useState<Step>('select');
  const [datasetTypeId, setDatasetTypeId] = useState('');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [taskType, setTaskType] = useState<TaskType>('DETECT');
  const [itemNames, setItemNames] = useState<Record<string, string>>({});
  const [itemClassFiles, setItemClassFiles] = useState<Record<string, string>>({});
  const [createResults, setCreateResults] = useState<CreateResult | null>(null);

  const { data: availableRaw, isLoading: availLoading } = useQuery({
    queryKey: ['available-source-dirs', datasetTypeId],
    enabled: !!datasetTypeId,
    queryFn: () => apiGetList<AvailableItem>(`/source-datasets/available?dataset_type_id=${datasetTypeId}`),
  });
  const available = availableRaw?.data;

  function toggleName(name: string) {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function goToReview() {
    if (!available) return;
    const names: Record<string, string> = {};
    const classFiles: Record<string, string> = {};
    for (const name of selectedNames) {
      // Discovery returns a sub_path, which for a DM archive is `check/<dataset>`.
      // Default the display name to the leaf so it does not carry the archive layout.
      names[name] = name.split('/').pop() || name;
      classFiles[name] = '';
    }
    setItemNames(names);
    setItemClassFiles(classFiles);
    setStep('review');
  }

  const createAll = useMutation({
    mutationFn: async () => {
      const succeeded: { name: string }[] = [];
      const failed: { name: string; error: string }[] = [];
      for (const name of selectedNames) {
        try {
          await apiSend('POST', '/source-datasets', {
            name: itemNames[name] || name,
            dataset_type_id: datasetTypeId,
            task_type: taskType,
            sub_path: name,
            classes_file_relative_path: itemClassFiles[name] || undefined,
          }, csrfToken);
          succeeded.push({ name });
        } catch (e) {
          failed.push({ name, error: (e as Error).message });
        }
      }
      return { succeeded, failed };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['source-datasets'] });
      if (result.failed.length === 0) onClose();
      else setCreateResults(result);
    },
  });

  function handleSelectType(e: React.ChangeEvent<HTMLSelectElement>) {
    setDatasetTypeId(e.target.value);
    setSelectedNames(new Set());
    setCreateResults(null);
  }

  return (
    <Modal
      title={step === 'select' ? 'New Source Dataset' : 'Review & Create'}
      onClose={onClose}
      footer={
        step === 'select' ? (
          <button
            className="btn btn-primary"
            disabled={selectedNames.size === 0}
            onClick={goToReview}
          >
            Next ({selectedNames.size})
          </button>
        ) : createResults ? (
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={createAll.isPending}
            onClick={() => createAll.mutate()}
          >
            {createAll.isPending ? 'Creating…' : `Create ${selectedNames.size} dataset(s)`}
          </button>
        )
      }
    >
      {createAll.error && !createResults && (
        <div className="form-error">{(createAll.error as Error).message}</div>
      )}

      {createResults && (
        <div className="create-results" style={{ marginBottom: 12 }}>
          <p style={{ color: '#4caf50' }}>{createResults.succeeded.length} succeeded</p>
          {createResults.failed.length > 0 && (
            <>
              <p style={{ color: '#f44336' }}>{createResults.failed.length} failed</p>
              <ul style={{ fontSize: 13, margin: '4px 0' }}>
                {createResults.failed.map((f) => (
                  <li key={f.name}><strong>{f.name}</strong>: {f.error}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <label className="field">
        <span>Dataset type</span>
        <select value={datasetTypeId} onChange={handleSelectType} disabled={dtLoading}>
          <option value="">Select…</option>
          {datasetTypes?.map((dt) => (
            <option key={dt.id} value={dt.id}>{dt.name}</option>
          ))}
        </select>
      </label>

      {step === 'select' && (
        <>
          <label className="field" style={{ marginTop: 8 }}>
            <span>Task type</span>
            <select value={taskType} onChange={(e) => setTaskType(e.target.value as TaskType)}>
              <option value="DETECT">DETECT</option>
              <option value="OBB">OBB</option>
            </select>
          </label>

          {availLoading && <SkeletonLoader rows={5} cols={3} />}

          {!availLoading && available && available.length === 0 && !!datasetTypeId && (
            <EmptyState size="small" message="No subdirectories with images/ and labels/ found under this dataset type path." />
          )}

          {!availLoading && available && available.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>Name</th>
                    <th style={{ width: 60 }}>Images</th>
                    <th style={{ width: 60 }}>Labels</th>
                    <th style={{ width: 80 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {available.map((item) => (
                    <tr key={item.name}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedNames.has(item.name)}
                          onChange={() => toggleName(item.name)}
                          disabled={item.isRegistered}
                        />
                      </td>
                      <td>{item.name}</td>
                      <td className="cell-sub">{item.imageCount}</td>
                      <td className="cell-sub">{item.labelCount}</td>
                      <td>
                        {item.isRegistered ? (
                          <span style={{ color: '#4caf50', fontSize: 12, fontWeight: 600 }}>ACTIVE</span>
                        ) : (
                          <span style={{ color: 'var(--text-sub)', fontSize: 12, fontWeight: 600 }}>NEW</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selectedNames.size > 0 && (
            <p style={{ fontSize: 13, marginTop: 8, color: 'var(--text-sub)' }}>
              {selectedNames.size} subdirectories selected
            </p>
          )}
        </>
      )}

      {step === 'review' && (
        <>
          <div className="table-wrap" style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Class file</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(selectedNames).sort().map((name) => (
                  <tr key={name}>
                    <td>
                      <input
                        value={itemNames[name] || name}
                        onChange={(e) => setItemNames((prev) => ({ ...prev, [name]: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box' }}
                      />
                    </td>
                    <td>
                      <input
                        value={itemClassFiles[name] || ''}
                        onChange={(e) => setItemClassFiles((prev) => ({ ...prev, [name]: e.target.value }))}
                        placeholder="e.g. classes.txt"
                        style={{ width: '100%', boxSizing: 'border-box' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 12, marginTop: 6, color: 'var(--text-sub)' }}>
            Class file path is relative to dataset root (e.g. classes.txt).
          </p>
        </>
      )}
    </Modal>
  );
}
