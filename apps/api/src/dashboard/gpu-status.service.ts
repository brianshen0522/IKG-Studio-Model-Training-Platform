import { Inject, Injectable } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely } from 'kysely';
import type { Database } from '@model-trainer/db';

/**
 * Per-GPU live telemetry for the dashboard, assembled from two sources:
 *
 *  - `workers.capabilities.devices[]` — the live sample ring the training-worker's
 *    GpuProbe publishes on every heartbeat (utilization, VRAM, temperature, power,
 *    plus a short rolling window for sparklines).
 *  - `job_execution_gpus` ⋈ `worker_gpus` — which execution currently holds which
 *    physical card, so a busy GPU can be attributed to a named job.
 *
 * Telemetry deliberately stays in `capabilities` rather than a new table: Postgres
 * remains the source of truth, and a bounded jsonb window needs no migration or
 * retention sweep. `worker_gpus` carries only the stable identity of each card.
 *
 * Staleness is computed here rather than trusted from the worker: a crashed worker
 * keeps its last `capabilities` forever, so the UI must be able to tell live numbers
 * from a frozen snapshot. Anything past `STALE_AFTER_S` is flagged, and `null` metrics
 * stay `null` — never coerced to 0, which would read as a real idle measurement.
 */

// Heartbeat is ~15s; allow a couple of misses before calling the sample stale.
const STALE_AFTER_S = 60;

interface DeviceSample {
  index?: number;
  uuid?: string | null;
  name?: string | null;
  memory_total_mb?: number | null;
  memory_used_mb?: number | null;
  // Legacy field names still emitted for the pre-existing DevicePicker.
  total_memory_mb?: number | null;
  used_memory_mb?: number | null;
  memory_used_pct?: number | null;
  utilization_pct?: number | null;
  memory_utilization_pct?: number | null;
  temperature_c?: number | null;
  power_w?: number | null;
  power_limit_w?: number | null;
  utilization_avg_pct?: number | null;
  utilization_max_pct?: number | null;
  memory_used_max_mb?: number | null;
  sample_count?: number | null;
  window_s?: number | null;
  utilization_series?: (number | null)[];
  memory_series?: (number | null)[];
}

interface Capabilities {
  devices?: DeviceSample[];
  gpu_telemetry?: { source?: string; interval_s?: number; supports_utilization?: boolean };
}

export interface GpuView {
  worker_key: string;
  hostname: string;
  worker_status: string;
  index: number;
  uuid: string | null;
  name: string;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
  memory_used_pct: number | null;
  utilization_pct: number | null;
  memory_utilization_pct: number | null;
  temperature_c: number | null;
  power_w: number | null;
  power_limit_w: number | null;
  utilization_avg_pct: number | null;
  utilization_max_pct: number | null;
  utilization_series: (number | null)[];
  memory_series: (number | null)[];
  window_s: number | null;
  supports_utilization: boolean;
  /** Last heartbeat is older than STALE_AFTER_S — numbers are a frozen snapshot. */
  stale: boolean;
  last_heartbeat_at: string | null;
  /** Jobs currently holding this card (empty when idle or when attribution is unknown). */
  active_jobs: { job_execution_id: string; job_type: string; job_id: string; job_name: string | null }[];
}

@Injectable()
export class GpuStatusService {
  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  async overview() {
    // Only TRAINING workers run GPU work; dataset/cleanup workers never report devices.
    const workers = await this.db
      .selectFrom('workers')
      .select(['id', 'worker_key', 'hostname', 'status', 'capabilities', 'last_heartbeat_at'])
      .where('disabled_at', 'is', null)
      .orderBy('worker_key')
      .execute();

    const allocations = await this.activeAllocations();
    const now = Date.now();
    const gpus: GpuView[] = [];

    for (const w of workers) {
      const caps = (w.capabilities ?? {}) as Capabilities;
      const devices = Array.isArray(caps.devices) ? caps.devices : [];
      if (devices.length === 0) continue;

      const beat = w.last_heartbeat_at ? new Date(w.last_heartbeat_at).getTime() : null;
      const stale = beat === null || now - beat > STALE_AFTER_S * 1000;
      // A stale worker's utilization is meaningless, but its card identity and VRAM
      // total are still accurate, so the GPU is listed and flagged rather than hidden.
      const supportsUtil = caps.gpu_telemetry?.supports_utilization === true;

      for (const d of devices) {
        const index = typeof d.index === 'number' ? d.index : 0;
        const totalMb = d.memory_total_mb ?? d.total_memory_mb ?? null;
        const usedMb = d.memory_used_mb ?? d.used_memory_mb ?? null;
        const uuid = d.uuid ?? null;
        gpus.push({
          worker_key: w.worker_key,
          hostname: w.hostname,
          worker_status: w.status,
          index,
          uuid,
          name: d.name ?? `GPU ${index}`,
          memory_total_mb: totalMb,
          memory_used_mb: usedMb,
          memory_used_pct:
            d.memory_used_pct ??
            (totalMb && usedMb !== null && totalMb > 0
              ? Math.round((usedMb / totalMb) * 1000) / 10
              : null),
          utilization_pct: d.utilization_pct ?? null,
          memory_utilization_pct: d.memory_utilization_pct ?? null,
          temperature_c: d.temperature_c ?? null,
          power_w: d.power_w ?? null,
          power_limit_w: d.power_limit_w ?? null,
          utilization_avg_pct: d.utilization_avg_pct ?? null,
          utilization_max_pct: d.utilization_max_pct ?? null,
          utilization_series: Array.isArray(d.utilization_series) ? d.utilization_series : [],
          memory_series: Array.isArray(d.memory_series) ? d.memory_series : [],
          window_s: d.window_s ?? null,
          supports_utilization: supportsUtil,
          stale,
          last_heartbeat_at: w.last_heartbeat_at,
          // Attribution needs a stable UUID; the torch-only fallback has none.
          active_jobs: uuid ? (allocations.get(uuid) ?? []) : [],
        });
      }
    }

    const liveUtil = gpus.filter((g) => !g.stale && g.utilization_pct !== null);
    const totalMb = gpus.reduce((sum, g) => sum + (g.stale ? 0 : (g.memory_total_mb ?? 0)), 0);
    const usedMb = gpus.reduce((sum, g) => sum + (g.stale ? 0 : (g.memory_used_mb ?? 0)), 0);

    return {
      gpus,
      summary: {
        gpu_count: gpus.length,
        // Excludes stale workers so a dead host can't inflate the fleet view.
        live_gpu_count: gpus.filter((g) => !g.stale).length,
        busy_gpu_count: gpus.filter((g) => !g.stale && g.active_jobs.length > 0).length,
        // null, not 0, when nothing reports utilization — "unknown" ≠ "idle".
        utilization_avg_pct: liveUtil.length
          ? Math.round(
              (liveUtil.reduce((s, g) => s + (g.utilization_pct ?? 0), 0) / liveUtil.length) * 10,
            ) / 10
          : null,
        memory_total_mb: totalMb,
        memory_used_mb: usedMb,
        memory_used_pct: totalMb > 0 ? Math.round((usedMb / totalMb) * 1000) / 10 : null,
      },
    };
  }

  /** gpu_uuid → executions still holding it, with the owning job's display name. */
  private async activeAllocations() {
    const rows = await this.db
      .selectFrom('job_execution_gpus as jeg')
      .innerJoin('worker_gpus as wg', 'wg.id', 'jeg.worker_gpu_id')
      .innerJoin('job_executions as je', 'je.id', 'jeg.job_execution_id')
      .leftJoin('training_jobs as tj', 'tj.id', 'je.job_id')
      .leftJoin('benchmark_runs as br', 'br.id', 'je.job_id')
      .select([
        'wg.gpu_uuid',
        'jeg.job_execution_id',
        'je.job_type',
        'je.job_id',
        'tj.name as training_name',
        'br.name as benchmark_name',
      ])
      .where('jeg.released_at', 'is', null)
      // A row whose execution already finished is a leaked allocation, not active work.
      .where('je.status', 'in', ['ASSIGNED', 'CLAIMED', 'PREPARING', 'RUNNING'])
      .execute();

    const map = new Map<string, GpuView['active_jobs']>();
    for (const r of rows) {
      const list = map.get(r.gpu_uuid) ?? [];
      list.push({
        job_execution_id: r.job_execution_id,
        job_type: r.job_type,
        job_id: r.job_id,
        job_name: r.training_name ?? r.benchmark_name ?? null,
      });
      map.set(r.gpu_uuid, list);
    }
    return map;
  }
}
