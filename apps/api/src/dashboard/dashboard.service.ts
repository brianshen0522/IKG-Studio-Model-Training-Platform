import { Inject, Injectable } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';

type Actor = { id: string; role: string };

@Injectable()
export class DashboardService {
  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  private async count(table: 'source_datasets' | 'training_datasets' | 'models' | 'training_jobs' | 'benchmark_runs'): Promise<number> {
    let q = this.db.selectFrom(table).select(sql<number>`count(*)`.as('c'));
    if (table === 'source_datasets' || table === 'training_datasets' || table === 'models') {
      q = q.where('archived_at', 'is', null);
    }
    const row = await q.executeTakeFirstOrThrow();
    return Number(row.c);
  }

  private async byStatus(table: 'models' | 'training_jobs' | 'benchmark_runs') {
    const rows = await this.db.selectFrom(table)
      .select(['status', sql<number>`count(*)`.as('count')])
      .groupBy('status').execute();
    return rows.map((r) => ({ status: r.status as string, count: Number(r.count) }));
  }

  async summary(actor: Actor) {
    const [sourceDatasets, datasets, models, trainingJobs, benchmarkRuns] = await Promise.all([
      this.count('source_datasets'), this.count('training_datasets'), this.count('models'),
      this.count('training_jobs'), this.count('benchmark_runs'),
    ]);

    const [modelsByStatus, trainingByStatus, benchmarkByStatus] = await Promise.all([
      this.byStatus('models'), this.byStatus('training_jobs'), this.byStatus('benchmark_runs'),
    ]);

    const activeTraining = await this.db.selectFrom('training_jobs')
      .select(['id', 'name', 'status', 'started_at', 'created_at'])
      .where('status', 'in', ['QUEUED', 'PREPARING', 'RUNNING', 'STOPPING'])
      .orderBy('created_at', 'desc').limit(10).execute();
    const activeBenchmark = await this.db.selectFrom('benchmark_runs')
      .select(['id', 'name', 'status', 'started_at', 'created_at'])
      .where('status', 'in', ['QUEUED', 'RUNNING'])
      .orderBy('created_at', 'desc').limit(10).execute();
    const activeJobs = [
      ...activeTraining.map((j) => ({ id: j.id, name: j.name, type: 'TRAINING', status: j.status, started_at: j.started_at })),
      ...activeBenchmark.map((j) => ({ id: j.id, name: j.name, type: 'BENCHMARK', status: j.status, started_at: j.started_at })),
    ];

    const recentModels = await this.db.selectFrom('models')
      .select(['id', 'name', 'version_label', 'task_type', 'source_type', 'status', 'created_at'])
      .where('archived_at', 'is', null).orderBy('created_at', 'desc').limit(5).execute();

    const recentBenchmarks = await this.db.selectFrom('benchmark_runs')
      .select(['id', 'name', 'status', 'evaluation_count', 'completed_count', 'failed_count', 'created_at'])
      .orderBy('created_at', 'desc').limit(5).execute();

    const unread = await this.db.selectFrom('notifications')
      .where('recipient_user_id', '=', actor.id).where('archived_at', 'is', null).where('read_at', 'is', null)
      .select(sql<number>`count(*)`.as('c')).executeTakeFirstOrThrow();

    // Recent activity: the user's own actions; admins get a global view.
    let activityQuery = this.db.selectFrom('audit_logs')
      .select(['id', 'action_code', 'resource_type_code', 'resource_id', 'result', 'occurred_at', 'actor_type']);
    if (actor.role !== 'ADMIN') activityQuery = activityQuery.where('actor_user_id', '=', actor.id);
    const recentActivities = await activityQuery.orderBy('id', 'desc').limit(10).execute();

    // System health: worker fleet + queue depth.
    const [workerRows, activeExec, pendingOutbox, deadOutbox] = await Promise.all([
      this.db.selectFrom('workers').select(['status', 'disabled_at']).execute(),
      this.db.selectFrom('job_executions').where('status', 'in', ['ASSIGNED', 'CLAIMED', 'PREPARING', 'RUNNING'])
        .select(sql<number>`count(*)`.as('c')).executeTakeFirstOrThrow(),
      this.db.selectFrom('outbox_events').where('status', 'in', ['PENDING', 'FAILED'])
        .select(sql<number>`count(*)`.as('c')).executeTakeFirstOrThrow(),
      this.db.selectFrom('outbox_events').where('status', '=', 'DEAD')
        .select(sql<number>`count(*)`.as('c')).executeTakeFirstOrThrow(),
    ]);
    const activeWorkers = workerRows.filter((w) => w.disabled_at === null);
    const workersOnline = activeWorkers.filter((w) => w.status !== 'OFFLINE').length;
    const workersOffline = activeWorkers.filter((w) => w.status === 'OFFLINE').length;

    return {
      system_health: {
        workers: { online: workersOnline, offline: workersOffline, total: activeWorkers.length },
        active_executions: Number(activeExec.c),
        pending_outbox: Number(pendingOutbox.c),
        dead_outbox: Number(deadOutbox.c),
      },
      totals: {
        source_datasets: sourceDatasets, training_datasets: datasets, models,
        training_jobs: trainingJobs, benchmark_runs: benchmarkRuns,
      },
      models_by_status: modelsByStatus,
      training_by_status: trainingByStatus,
      benchmark_by_status: benchmarkByStatus,
      active_jobs: activeJobs,
      recent_models: recentModels,
      recent_benchmarks: recentBenchmarks,
      notifications: { unread_count: Number(unread.c) },
      recent_activities: recentActivities.map((a) => ({
        id: Number(a.id), action_code: a.action_code, resource_type_code: a.resource_type_code,
        resource_id: a.resource_id, result: a.result, occurred_at: a.occurred_at, actor_type: a.actor_type,
      })),
    };
  }
}
