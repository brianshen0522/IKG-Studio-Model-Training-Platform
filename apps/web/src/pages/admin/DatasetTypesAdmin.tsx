import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import { apiSend } from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import { SkeletonLoader } from '../../components/SkeletonLoader';
import { EmptyState } from '../../components/EmptyState';
import { queryClient } from '../../lib/queryClient';
import { useAuthStore } from '../../stores/auth';
import { NewDatasetTypeDialog } from '../../components/NewDatasetTypeDialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';

interface TreeNode {
  id: string;
  name: string;
  parent_id: string | null;
  enabled: boolean;
  effective_enabled: boolean;
  is_system: boolean;
  sort_order: number;
  dataset_path: string | null;
  model_path: string | null;
  training_dataset_path: string | null;
  row_version: number;
  effective_dataset_path: { dataset_path: string; inherited: boolean; inherited_from_dataset_type_id: string } | null;
  usage: {
    source_dataset_count: number;
    dataset_count: number;
    model_count: number;
    direct_child_count: number;
  };
  children: TreeNode[];
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  toggle,
  onToggleEnabled,
  onEdit,
  onDelete,
  actionPending,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  onToggleEnabled: (id: string, verb: string) => void;
  onEdit: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
  actionPending: boolean;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);

  const usageParts: string[] = [];
  if (node.usage.dataset_count > 0) usageParts.push(`${node.usage.dataset_count} datasets`);
  if (node.usage.model_count > 0) usageParts.push(`${node.usage.model_count} models`);

  return (
    <>
      <tr>
        <td className="cell-title" style={{ paddingLeft: depth * 20 + 4 }}>
          {hasChildren && (
            <span
              className="tree-toggle"
              onClick={() => toggle(node.id)}
              style={{ cursor: 'pointer', userSelect: 'none', marginRight: 4 }}
            >
              {isExpanded ? '▾' : '▸'}
            </span>
          )}
          {!hasChildren && <span style={{ marginRight: 12 }} />}
          {node.name}
        </td>
        <td className="cell-sub" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.effective_dataset_path
            ? node.effective_dataset_path.dataset_path + (node.effective_dataset_path.inherited ? ' (inherited)' : '')
            : <span style={{ opacity: 0.5 }}>—</span>}
        </td>
        <td className="cell-sub" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.model_path || <span style={{ opacity: 0.5 }}>—</span>}
        </td>
        <td>
          <StatusBadge status={node.enabled ? 'ACTIVE' : 'DISABLED'} />
        </td>
        <td className="cell-sub">
          {usageParts.length > 0 ? usageParts.join(' · ') : '—'}
        </td>
         <td>
           <div className="actions">
             {!node.is_system && (
               <button className="btn btn-sm" onClick={() => onEdit(node)}>Edit</button>
             )}
             {node.is_system ? (
               <span className="cell-sub">system</span>
             ) : node.enabled ? (
               <button
                 className="btn btn-sm"
                 disabled={actionPending}
                 onClick={() => onToggleEnabled(node.id, 'disable')}
               >
                 Disable
               </button>
             ) : (
               <button
                 className="btn btn-sm"
                 disabled={actionPending}
                 onClick={() => onToggleEnabled(node.id, 'enable')}
                 >
                   Enable
                 </button>
               )}
               {!node.is_system && (
                 <button
                   className="btn btn-sm btn-danger"
                   disabled={actionPending}
                   onClick={() => onDelete(node)}
                 >
                   Delete
                 </button>
               )}
           </div>
         </td>
      </tr>
       {hasChildren && isExpanded && node.children.map((child) => (
         <TreeNodeRow
           key={child.id}
           node={child}
           depth={depth + 1}
           expanded={expanded}
           toggle={toggle}
           onToggleEnabled={onToggleEnabled}
           onEdit={onEdit}
           onDelete={onDelete}
           actionPending={actionPending}
         />
       ))}
    </>
  );
}

export function DatasetTypesAdmin() {
  const [showNew, setShowNew] = useState(false);
  const [editingNode, setEditingNode] = useState<TreeNode | null>(null);
  const [deletingNode, setDeletingNode] = useState<TreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-dataset-types-tree'],
    queryFn: () => apiGet<TreeNode[]>('/admin/dataset-types/tree'),
  });

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: string }) =>
      apiSend('POST', `/admin/dataset-types/${id}/${verb}`, undefined, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-dataset-types-tree'] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/admin/dataset-types/${id}`, undefined, csrfToken),
    onSuccess: () => {
      setDeletingNode(null);
      queryClient.invalidateQueries({ queryKey: ['admin-dataset-types-tree'] });
    },
  });

  function toggleNode(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const tree = data ?? [];

  return (
    <section className="page">
      <header className="page-head">
        <h2>Dataset Types</h2>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => setShowNew(true)}>
          New Root Type
        </button>
      </header>

      {isLoading && <SkeletonLoader rows={5} cols={6} />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && data.length === 0 && (
        <EmptyState message="No dataset types yet." />
      )}

      {tree.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Dataset Path</th>
                <th>Model Path</th>
                <th>Enabled</th>
                <th>Usage</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
       {tree.map((rootNode) => (
         <TreeNodeRow
           onEdit={setEditingNode}
           key={rootNode.id}
           node={rootNode}
           depth={0}
           expanded={expanded}
           toggle={toggleNode}
           onToggleEnabled={(id, verb) => action.mutate({ id, verb })}
           onDelete={setDeletingNode}
           actionPending={action.isPending}
         />
       ))}
            </tbody>
          </table>
        </div>
      )}

      {deletingNode && (() => {
        // Mirrors the server's ON DELETE RESTRICT checks so the blockers are named
        // before the request rather than as a 400. usage.dataset_count excludes
        // archived training datasets while the FK does not, so the server can still
        // refuse when this looks clear — its message is shown if that happens.
        const u = deletingNode.usage;
        const blockers: string[] = [];
        if (u.direct_child_count > 0) blockers.push(`${u.direct_child_count} child type(s)`);
        if (u.dataset_count > 0) blockers.push(`${u.dataset_count} training dataset(s)`);
        if (u.source_dataset_count > 0) blockers.push(`${u.source_dataset_count} source dataset(s)`);
        if (u.model_count > 0) blockers.push(`${u.model_count} model(s)`);
        return (
          <ConfirmDialog
            title={`Delete "${deletingNode.name}"`}
            message={blockers.length > 0
              ? `This type is still referenced by ${blockers.join(', ')} and cannot be deleted. Archive or remove them first, or disable the type instead.`
              : 'Delete this dataset type? Nothing on disk is touched — only the type and its cached folder index are removed. This cannot be undone.'}
            confirmLabel={deleteMut.isPending ? 'Deleting…' : 'Delete'}
            danger
            error={deleteMut.error ? (deleteMut.error as Error).message : null}
            confirmDisabled={blockers.length > 0 || deleteMut.isPending}
            onCancel={() => { deleteMut.reset(); setDeletingNode(null); }}
            onConfirm={() => deleteMut.mutate(deletingNode.id)}
          />
        );
      })()}

      {showNew && (
         <NewDatasetTypeDialog onClose={() => setShowNew(false)} />
       )}
      {editingNode && (
        <NewDatasetTypeDialog
          onClose={() => setEditingNode(null)}
          editing={{
            id: editingNode.id,
            name: editingNode.name,
            dataset_path: editingNode.dataset_path,
            model_path: editingNode.model_path,
            training_dataset_path: editingNode.training_dataset_path,
            row_version: editingNode.row_version,
          }}
        />
      )}
    </section>
  );
}
