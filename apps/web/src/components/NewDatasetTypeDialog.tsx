import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiSend } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { isPathOk, type PathStatus } from '../lib/path';
import { Modal } from './Modal';
import { PathField } from './PathField';

/** The subset of a dataset type this dialog can edit. */
export interface EditableDatasetType {
  id: string;
  name: string;
  description?: string | null;
  dataset_path?: string | null;
  model_path?: string | null;
  training_dataset_path?: string | null;
  row_version: number;
}

export function NewDatasetTypeDialog({
  onClose,
  parentId,
  parentName,
  editing,
}: {
  onClose: () => void;
  parentId?: string | null;
  parentName?: string;
  /** When set, the dialog edits this type instead of creating a new one. */
  editing?: EditableDatasetType;
}) {
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [datasetPath, setDatasetPath] = useState(editing?.dataset_path ?? '');
  const [modelPath, setModelPath] = useState(editing?.model_path ?? '');
  const [trainingDatasetPath, setTrainingDatasetPath] = useState(editing?.training_dataset_path ?? '');
  const [datasetStatus, setDatasetStatus] = useState<PathStatus>({ kind: 'idle' });
  const [modelStatus, setModelStatus] = useState<PathStatus>({ kind: 'idle' });
  const [trainingStatus, setTrainingStatus] = useState<PathStatus>({ kind: 'idle' });

  // The three roots hold different things — sources, trained models, merged training
  // datasets — and pointing two of them at one directory means a build writes into the
  // model root, or a scan walks into build output. Caught here rather than at run time.
  const t = { dataset: datasetPath.trim(), model: modelPath.trim(), training: trainingDatasetPath.trim() };
  const collidesWith = (self: keyof typeof t): string | null => {
    const mine = t[self];
    if (mine === '') return null;
    const other = (Object.keys(t) as (keyof typeof t)[])
      .find((k) => k !== self && t[k] === mine);
    if (!other) return null;
    const LABEL = { dataset: 'the dataset path', model: 'the model path', training: 'the training dataset path' };
    return `Must differ from ${LABEL[other]}`;
  };
  const datasetCollision = collidesWith('dataset');
  const modelCollision = collidesWith('model');
  const trainingCollision = collidesWith('training');

  const pathsReady =
    isPathOk(datasetStatus) && !datasetCollision &&
    isPathOk(modelStatus) && !modelCollision &&
    // Optional: blank is fine, but a filled-in value still has to be valid.
    (t.training === '' ? true : isPathOk(trainingStatus) && !trainingCollision);

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name,
        description: description || null,
        dataset_path: t.dataset,
        model_path: t.model,
        training_dataset_path: t.training || null,
      };
      // row_version travels with the edit so a concurrent change is rejected rather
      // than silently overwritten.
      return editing
        ? apiSend('PATCH', `/admin/dataset-types/${editing.id}`, { ...body, row_version: editing.row_version }, csrfToken)
        : apiSend('POST', '/admin/dataset-types', { ...body, parent_id: parentId ?? null }, csrfToken);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-dataset-types-tree'] });
      onClose();
    },
  });

  return (
    <Modal
      title={editing ? `Edit ${editing.name}` : parentName ? 'New Child Dataset Type' : 'New Dataset Type'}
      onClose={onClose}
      footer={
      <button
        className="btn btn-primary"
        disabled={mutation.isPending || !name || !pathsReady}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? (editing ? 'Saving…' : 'Creating…') : (editing ? 'Save' : 'Create')}
      </button>
      }
    >
      {mutation.error && (
        <div className="form-error">{(mutation.error as Error).message}</div>
      )}
      {parentName && (
        <div className="field field-readonly">
          <span>Parent</span>
          <span>{parentName}</span>
        </div>
      )}
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Description (optional)</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <PathField
        label="Dataset path (required)"
        value={datasetPath}
        onChange={setDatasetPath}
        status={datasetStatus}
        onStatusChange={setDatasetStatus}
        collision={datasetCollision}
        required
        placeholder="/data/source-datasets/vehicles"
        hint="Absolute path for source datasets."
        browserTitle="Select Dataset Path"
      />
      <PathField
        label="Model path (required)"
        value={modelPath}
        onChange={setModelPath}
        status={modelStatus}
        onStatusChange={setModelStatus}
        collision={modelCollision}
        required
        placeholder="/data/models/vehicles"
        hint="Absolute path for trained models of this type."
        browserTitle="Select Model Path"
      />
      <PathField
        label="Training dataset path (required)"
        value={trainingDatasetPath}
        onChange={setTrainingDatasetPath}
        status={trainingStatus}
        onStatusChange={setTrainingStatus}
        collision={trainingCollision}
        required
        placeholder="/data/training/vehicles"
        hint="Absolute path for merged training datasets of this type."
        browserTitle="Select Training Dataset Path"
      />
    </Modal>
  );
}
