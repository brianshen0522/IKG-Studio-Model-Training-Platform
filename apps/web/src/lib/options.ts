import { useQuery } from '@tanstack/react-query';
import { apiGet, apiGetAll } from './api';

const FRESH = { staleTime: 0, refetchOnMount: 'always' } as const;

export interface Option {
  id: string;
  name: string;
}

export function useDatasetTypeOptions() {
  return useQuery({
    queryKey: ['dt-options'],
    queryFn: () => apiGet<Option[]>('/dataset-types/options'),
    ...FRESH,
  });
}

export interface DatasetOption {
  id: string;
  name: string;
  task_type: string;
  status: string;
}

export interface ModelOption {
  id: string;
  name: string;
  version_label: string | null;
  task_type: string;
  source_type: string;
  status: string;
}

export function useTrainingDatasetOptions() {
  return useQuery({
    queryKey: ['training-dataset-options'],
    queryFn: () => apiGetAll<DatasetOption>('/training-datasets'),
    ...FRESH,
  });
}

export function useModelOptions() {
  return useQuery({
    queryKey: ['model-options'],
    queryFn: () => apiGetAll<ModelOption>('/models'),
    ...FRESH,
  });
}

export interface SourceDatasetOption {
  id: string;
  name: string;
  task_type: string;
  status: string;
  dataset_type_id: string;
}

export function useSourceDatasetOptions() {
  return useQuery({
    queryKey: ['source-dataset-options'],
    queryFn: () => apiGetAll<SourceDatasetOption>('/source-datasets'),
    ...FRESH,
  });
}
