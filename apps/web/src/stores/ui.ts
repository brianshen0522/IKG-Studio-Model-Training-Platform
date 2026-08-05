import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Page = 'dashboard' | 'datasets' | 'models' | 'training' | 'benchmarks' | 'jobs' | 'notifications' | 'admin' | 'account';

export type AdminTab = 'users' | 'dataset-types' | 'audit' | 'settings' | 'workers' | 'backup';

export type DatasetTab = 'source' | 'training';

/** Jobs list filters. Empty string means "no filter" for both. */
export interface JobsFilter {
  jobType: string;
  statusTab: string;
}

interface UiState {
  page: Page;
  setPage: (page: Page) => void;
  adminTab: AdminTab;
  setAdminTab: (tab: AdminTab) => void;
  datasetTab: DatasetTab;
  setDatasetTab: (tab: DatasetTab) => void;
  jobsFilter: JobsFilter;
  setJobsFilter: (patch: Partial<JobsFilter>) => void;
  /** Collapse state of type-group sections, keyed `${page}::${groupId}`. Missing = collapsed. */
  groupCollapsed: Record<string, boolean>;
  setGroupCollapsed: (patch: Record<string, boolean>) => void;
  /** Set when a model detail jumps into a training job; consumed by TrainingJobsPage's
   *  Back so it returns to that model instead of the training list. Transient, not persisted. */
  trainingReturnModelId: string | null;
  setTrainingReturnModelId: (id: string | null) => void;
  /** Set when a model detail jumps into a training dataset; consumed by TrainingDatasetsPage's
   *  Back so it returns to that model instead of the training list. Transient, not persisted. */
  datasetReturnModelId: string | null;
  setDatasetReturnModelId: (id: string | null) => void;
  /** Set when a training dataset detail jumps into one of its source datasets; consumed by
   *  SourceDatasetsPage's Back so it returns to that training dataset instead of the source list. */
  sourceReturnTrainingDatasetId: string | null;
  setSourceReturnTrainingDatasetId: (id: string | null) => void;
  /** Set when a training job detail jumps into its base model; consumed by ModelsPage's
   *  Back so it returns to that training job instead of the models list. */
  modelsReturnTrainingJobId: string | null;
  setModelsReturnTrainingJobId: (id: string | null) => void;
}

const defaultUiState = {
  page: 'dashboard' as Page,
  adminTab: 'users' as AdminTab,
  datasetTab: 'source' as DatasetTab,
  jobsFilter: { jobType: '', statusTab: '' } as JobsFilter,
  groupCollapsed: {} as Record<string, boolean>,
};

// Persist the active page so a reload stays on the same tab instead of resetting to Home.
// The Jobs filters ride along for the same reason: narrowing to one job type and then
// losing it on every refresh made the page unusable while watching a run.
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      page: 'dashboard',
      setPage: (page) => set({ page }),
      adminTab: 'users',
      setAdminTab: (tab) => set({ adminTab: tab }),
      datasetTab: 'source',
      setDatasetTab: (tab) => set({ datasetTab: tab }),
      jobsFilter: { jobType: '', statusTab: '' },
      setJobsFilter: (patch) => set((s) => ({ jobsFilter: { ...s.jobsFilter, ...patch } })),
      groupCollapsed: {},
      setGroupCollapsed: (patch) => set((s) => ({ groupCollapsed: { ...s.groupCollapsed, ...patch } })),
      trainingReturnModelId: null,
      setTrainingReturnModelId: (id) => set({ trainingReturnModelId: id }),
      datasetReturnModelId: null,
      setDatasetReturnModelId: (id) => set({ datasetReturnModelId: id }),
      sourceReturnTrainingDatasetId: null,
      setSourceReturnTrainingDatasetId: (id) => set({ sourceReturnTrainingDatasetId: id }),
      modelsReturnTrainingJobId: null,
      setModelsReturnTrainingJobId: (id) => set({ modelsReturnTrainingJobId: id }),
    }),
    {
      name: 'yolo-ui',
      partialize: (s) => ({ page: s.page, jobsFilter: s.jobsFilter, adminTab: s.adminTab, datasetTab: s.datasetTab, groupCollapsed: s.groupCollapsed }),
      // Older persisted payloads predate jobsFilter; without a default here the page
      // would read `undefined.jobType` and crash on first load after upgrading.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<UiState>),
        jobsFilter: { ...current.jobsFilter, ...((persisted as Partial<UiState>)?.jobsFilter ?? {}) },
      }),
    },
  ),
);

// Browsing state (page, filters, expanded groups) is per-browser localStorage, not
// per-user server state. Without this, logging in as a different user on the same
// browser inherits whatever page/filters the previous user left behind.
export function resetUiStoreForNewSession() {
  useUiStore.setState(defaultUiState);
}
