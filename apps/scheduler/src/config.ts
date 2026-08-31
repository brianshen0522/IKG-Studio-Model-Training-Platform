export interface Config {
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  tickIntervalMs: number;
  executionStaleTimeoutS: number;
  workerOfflineTimeoutS: number;
  // How often each dataset type's directory index is refreshed in the background
  // (seconds). Drives the auto-archive/purge of source datasets whose folder was
  // removed from disk. 0 disables periodic reindexing.
  datasetReindexIntervalS: number;
  retry: {
    // Max total attempts for a training job before a lost execution gives up and the job FAILs.
    maxTrainingAttempts: number;
    // Exponential backoff base (seconds): delay = base * 2^(attempt-2), capped below the stale timeout.
    backoffBaseS: number;
    // Only auto-retry worker-FAILED jobs that failed within this window (seconds) —
    // prevents a retry storm over old failures on deploy.
    failedWindowS: number;
  };
}

function num(env: string | undefined, fallback: number): number {
  return Number(env ?? fallback);
}

export const config: Config = {
  postgres: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: num(process.env.POSTGRES_PORT, 5432),
    database: process.env.POSTGRES_DB ?? 'model_trainer',
    user: process.env.POSTGRES_USER ?? 'scheduler_role',
    password: process.env.POSTGRES_PASSWORD ?? '',
  },
  tickIntervalMs: num(process.env.SCHEDULER_TICK_INTERVAL_MS, 3000),
  executionStaleTimeoutS: num(process.env.EXECUTION_STALE_TIMEOUT_S, 600),
  workerOfflineTimeoutS: num(process.env.WORKER_OFFLINE_TIMEOUT_S, 90),
  datasetReindexIntervalS: num(process.env.DATASET_REINDEX_INTERVAL_S, 3600),
  retry: {
    maxTrainingAttempts: num(process.env.MAX_TRAINING_ATTEMPTS, 3),
    backoffBaseS: num(process.env.RETRY_BACKOFF_BASE_S, 20),
    failedWindowS: num(process.env.RETRY_FAILED_WINDOW_S, 3600),
  },
};
