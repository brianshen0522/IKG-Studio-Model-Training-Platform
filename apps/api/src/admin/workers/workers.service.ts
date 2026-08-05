import { Inject, Injectable } from '@nestjs/common';
import { DB_PROVIDER } from '../../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';

const FIELDS = [
  'worker_key', 'worker_type', 'hostname', 'status',
  'python_version', 'torch_version', 'ultralytics_version', 'cuda_version', 'capabilities',
  'active_job_count', 'last_heartbeat_at', 'registered_at', 'disabled_at',
] as const;

@Injectable()
export class WorkersService {
  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  async list() {
    return this.db.selectFrom('workers').select(FIELDS)
      .orderBy('worker_key').execute();
  }
}
