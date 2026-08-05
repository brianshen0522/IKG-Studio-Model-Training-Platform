import { Injectable, Inject, OnModuleInit, HttpException } from '@nestjs/common';
import { Client } from 'minio';
import { Kysely } from 'kysely';
import { Database } from '@model-trainer/db';
import { DB_PROVIDER } from '../database/database.module';
import { errorCode } from '@model-trainer/shared-types';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

export interface StorageStatus {
  used_bytes: number;
  limit_bytes: number;
  warning_threshold_percent: number;
  used_percent: number;
  is_warning: boolean;
  is_exceeded: boolean;
}

@Injectable()
export class MinioService implements OnModuleInit {
  private client!: Client;
  private cachedUsedBytes = 0;
  private lastStatsFetchTime = 0;

  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  onModuleInit() {
    this.client = new Client({
      endPoint: process.env.MINIO_ENDPOINT?.split(':')[0] ?? 'minio',
      port: Number(process.env.MINIO_ENDPOINT?.split(':')[1] ?? 9000),
      accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
      secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
      useSSL: (process.env.MINIO_SECURE ?? 'false') === 'true',
    });
  }

  async getStorageUsedBytes(forceRefresh = false): Promise<number> {
    const now = Date.now();
    if (!forceRefresh && now - this.lastStatsFetchTime < 60000) {
      return this.cachedUsedBytes;
    }

    try {
      const buckets = await this.client.listBuckets();
      let totalBytes = 0;

      for (const bucket of buckets) {
        if (!bucket.name) continue;
        const stream = this.client.listObjectsV2(bucket.name, '', true);
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (obj) => {
            if (obj && typeof obj.size === 'number') {
              totalBytes += obj.size;
            }
          });
          stream.on('end', () => resolve());
          stream.on('error', (e) => reject(e));
        });
      }

      this.cachedUsedBytes = totalBytes;
      this.lastStatsFetchTime = now;
      return totalBytes;
    } catch {
      return this.cachedUsedBytes;
    }
  }

  async getStorageStatus(forceRefresh = false): Promise<StorageStatus> {
    const usedBytes = await this.getStorageUsedBytes(forceRefresh);

    const limitRow = await this.db
      .selectFrom('system_settings')
      .select('value')
      .where('setting_key', '=', 'storage_minio_limit_bytes')
      .executeTakeFirst();

    const thresholdRow = await this.db
      .selectFrom('system_settings')
      .select('value')
      .where('setting_key', '=', 'storage_warning_threshold_percent')
      .executeTakeFirst();

    const limitBytes = Number(limitRow?.value ?? 107374182400); // Default 100 GiB
    const thresholdPercent = Number(thresholdRow?.value ?? 85);

    const usedPercent = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;
    const isExceeded = limitBytes > 0 && usedBytes >= limitBytes;
    const isWarning = limitBytes > 0 && usedPercent >= thresholdPercent;

    return {
      used_bytes: usedBytes,
      limit_bytes: limitBytes,
      warning_threshold_percent: thresholdPercent,
      used_percent: Number(usedPercent.toFixed(2)),
      is_warning: isWarning,
      is_exceeded: isExceeded,
    };
  }

  async checkStorageQuota(additionalBytes = 0): Promise<void> {
    const status = await this.getStorageStatus(true);
    if (status.limit_bytes > 0 && status.used_bytes + additionalBytes > status.limit_bytes) {
      throw err(
        errorCode.STORAGE_LIMIT_EXCEEDED,
        `Storage quota exceeded. Used: ${status.used_bytes} B, Required: ${additionalBytes} B, Limit: ${status.limit_bytes} B`,
        400,
      );
    }
  }

  async presignedGetUrl(bucket: string, key: string, expires = 3600): Promise<string> {
    return this.client.presignedGetObject(bucket, key, expires);
  }

  async putBuffer(bucket: string, key: string, data: Buffer, contentType: string): Promise<void> {
    await this.checkStorageQuota(data.length);
    if (!(await this.client.bucketExists(bucket))) {
      await this.client.makeBucket(bucket);
    }
    await this.client.putObject(bucket, key, data, data.length, { 'Content-Type': contentType });
  }

  async removeObject(bucket: string, key: string): Promise<void> {
    await this.client.removeObject(bucket, key);
  }
}
