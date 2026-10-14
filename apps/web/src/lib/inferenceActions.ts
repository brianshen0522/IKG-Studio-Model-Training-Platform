import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiSend, readCsrfCookie } from './api';

export function useStopInferenceRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => apiSend('POST', `/inference-runs/${runId}/stop`, undefined, readCsrfCookie()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inference-runs'] });
      qc.invalidateQueries({ queryKey: ['inference-run'] });
    },
  });
}

export function useRetryInferenceRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiSend<{ id: string }>('POST', `/inference-runs/${runId}/retry`, undefined, readCsrfCookie()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inference-runs'] });
      qc.invalidateQueries({ queryKey: ['inference-run'] });
    },
  });
}

export function useDeleteInferenceRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiSend<{ id: string; diff_rows: number; zip_bytes: number }>('DELETE', `/inference-runs/${runId}`, undefined, readCsrfCookie()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inference-runs'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

const STOPPABLE = new Set(['QUEUED', 'RUNNING']);
// COMPLETED is not retryable: retry re-runs only the datasets that did not
// complete, and in a COMPLETED run there are none.
const RETRYABLE = new Set(['PARTIALLY_FAILED', 'FAILED', 'CANCELLED', 'STOPPED']);

// A running run is stopped first, so no worker writes diffs while they go.
const UNDELETABLE = new Set(['RUNNING', 'STOPPING', 'DELETED']);

export const canStop = (status: string) => STOPPABLE.has(status);
export const canDelete = (status: string) => !UNDELETABLE.has(status);
export const canRetry = (status: string) => RETRYABLE.has(status);
export const stopLabel = (status: string) => (status === 'RUNNING' ? 'Stop' : 'Cancel');
