import { sql } from 'kysely';
import { createDb } from '@model-trainer/db';
import { config } from './config';
import { logger } from './logger';
import { reconcileStaleExecutions } from './reconcile';
import { retryFailedTrainingJobs } from './retry';
import { promoteBlockedTrainingJobs } from './promote';
import { markStaleWorkersOffline } from './workers';

const { db, pool } = createDb({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
});

let isRunning = false;
let shuttingDown = false;
let timer: NodeJS.Timeout | null = null;

// Leader election: with multiple scheduler instances, only the one that holds this
// session-level advisory lock runs the stages in a given tick. The lock is taken and
// released on a single dedicated connection (pool-safe); the stages run on the pool.
const LEADER_LOCK_KEY = 911_000_001;

async function runStages(): Promise<void> {
    try {
      const r = await reconcileStaleExecutions(db, config.executionStaleTimeoutS, config.retry);
      if (r.lost > 0 || r.retried > 0 || r.failed > 0) {
        logger.info('tick complete', { lost: r.lost, retried: r.retried, failed: r.failed });
      }
    } catch (err) {
      logger.error('stage reconcileStaleExecutions failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const errorRetried = await retryFailedTrainingJobs(db, {
        maxTrainingAttempts: config.retry.maxTrainingAttempts,
        backoffBaseS: config.retry.backoffBaseS,
        staleTimeoutS: config.executionStaleTimeoutS,
        windowS: config.retry.failedWindowS,
      });
      if (errorRetried > 0) {
        logger.info('failed-job retry stage complete', { errorRetried });
      }
    } catch (err) {
      logger.error('stage retryFailedTrainingJobs failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const r = await promoteBlockedTrainingJobs(db);
      if (r.promoted > 0 || r.failed > 0) {
        logger.info('promote stage complete', { promoted: r.promoted, failed: r.failed });
      }
    } catch (err) {
      logger.error('stage promoteBlockedTrainingJobs failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const offlined = await markStaleWorkersOffline(db, config.workerOfflineTimeoutS);
      if (offlined > 0) {
        logger.info('workers marked offline', { count: offlined });
      }
    } catch (err) {
      logger.error('stage markStaleWorkersOffline failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
}

async function tick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    await db.connection().execute(async (conn) => {
      const lock = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(${LEADER_LOCK_KEY}) AS locked`.execute(conn);
      if (!lock.rows[0]?.locked) return; // another instance is the leader this tick
      try {
        await runStages();
      } finally {
        await sql`SELECT pg_advisory_unlock(${LEADER_LOCK_KEY})`.execute(conn);
      }
    });
  } finally {
    isRunning = false;
  }
}

function scheduleNext(): void {
  if (shuttingDown) return;
  timer = setTimeout(() => {
    void tick().finally(scheduleNext);
  }, config.tickIntervalMs);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('scheduler shutting down');
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  while (isRunning) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    await pool.end();
  } catch (err) {
    logger.error('pool end failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});

logger.info('scheduler started', {
  tickIntervalMs: config.tickIntervalMs,
  executionStaleTimeoutS: config.executionStaleTimeoutS,
});

void tick().finally(scheduleNext);
