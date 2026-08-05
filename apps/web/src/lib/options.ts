import { useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList } from './api';

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
    queryFn: async () => (await apiGetList<DatasetOption>('/training-datasets?size=100')).data,
    ...FRESH,
  });
}

export function useModelOptions() {
  return useQuery({
    queryKey: ['model-options'],
    queryFn: async () => (await apiGetList<ModelOption>('/models?size=100')).data,
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
    queryFn: async () =>
      (await apiGetList<SourceDatasetOption>('/source-datasets?size=100')).data,
    ...FRESH,
  });
}
