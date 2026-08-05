import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiSend, readCsrfCookie } from './api';

export function useStopBenchmarkRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (benchmarkRunId: string) =>
      apiSend('POST', `/benchmark-runs/${benchmarkRunId}/stop`, undefined, readCsrfCookie()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['benchmark-runs'] });
      qc.invalidateQueries({ queryKey: ['benchmark-run'] });
    },
  });
}

export function useRetryBenchmarkRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (benchmarkRunId: string) =>
      apiSend<{ id: string }>('POST', `/benchmark-runs/${benchmarkRunId}/retry`, undefined, readCsrfCookie()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['benchmark-runs'] });
    },
  });
}

const STOPPABLE = new Set(['QUEUED', 'RUNNING', 'STOPPING']);
const RETRYABLE = new Set(['COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED', 'STOPPED']);

export function canStop(status: string): boolean {
  return STOPPABLE.has(status);
}

export function canRetry(status: string): boolean {
  return RETRYABLE.has(status);
}

export function stopLabel(status: string): string {
  return status === 'RUNNING' ? 'Stop Benchmark' : 'Cancel';
}
