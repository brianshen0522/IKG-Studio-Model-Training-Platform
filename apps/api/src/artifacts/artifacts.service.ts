import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely } from 'kysely';
import type { Database } from '@model-trainer/db';
import { MinioService } from '../minio/minio.service';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);
const ARTIFACT_NOT_FOUND = 'ARTIFACT_NOT_FOUND';

const ARTIFACT_FIELDS = [
  'id', 'owner_type_code', 'artifact_type_code', 'bucket_name', 'object_key',
  'filename', 'extension', 'mime_type', 'file_size_bytes', 'is_primary', 'created_at',
] as const;

@Injectable()
export class ArtifactsService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly minio: MinioService,
  ) {}

  async list(ownerTypeCode: string, ownerId: string) {
    const rows = await this.db.selectFrom('artifacts')
      .select(ARTIFACT_FIELDS)
      .where('owner_type_code', '=', ownerTypeCode)
      .where('owner_id', '=', ownerId)
      .where('status', 'in', ['STORED', 'VERIFIED'])
      .orderBy('artifact_type_code')
      .orderBy('created_at')
      .execute();
    return rows;
  }

  async get(id: string) {
    const row = await this.db.selectFrom('artifacts')
      .select(ARTIFACT_FIELDS)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw err(ARTIFACT_NOT_FOUND, 'artifact not found', 404);
    return row;
  }

  async presignedUrl(id: string, inline = false): Promise<{ url: string; filename: string; mime_type: string }> {
    const a = await this.get(id);
    let filename = a.filename;
    if (inline && a.extension) {
      const base = a.filename.replace(/\.[^.]+$/, '');
      filename = `${base}${a.extension}`;
    }
    const url = await this.minio.presignedGetUrl(a.bucket_name, a.object_key, 3600);
    return { url, filename, mime_type: a.mime_type };
  }
}
