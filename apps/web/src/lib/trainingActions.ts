import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiSend, readCsrfCookie } from './api';

export function useStopTrainingJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trainingJobId: string) =>
      apiSend('POST', `/training-jobs/${trainingJobId}/stop`, undefined, readCsrfCookie()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['training-jobs'] });
      qc.invalidateQueries({ queryKey: ['training-job'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['job-detail'] });
    },
  });
}

export function useRetryTrainingJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trainingJobId: string) =>
      apiSend<{ id: string }>('POST', `/training-jobs/${trainingJobId}/retry`, undefined, readCsrfCookie()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['training-jobs'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

const STOPPABLE = new Set(['QUEUED', 'PREPARING', 'SCHEDULED', 'BLOCKED', 'RUNNING', 'STOPPING']);
const RETRYABLE = new Set(['FAILED', 'CANCELLED', 'STOPPED']);

export function canStop(status: string): boolean {
  return STOPPABLE.has(status);
}

export function canRetry(status: string): boolean {
  return RETRYABLE.has(status);
}

export function stopLabel(status: string): string {
  return status === 'RUNNING' ? 'Stop Training' : 'Cancel';
}
