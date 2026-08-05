import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { ArtifactsService } from './artifacts.service';

@Roles('ADMIN', 'USER')
@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly service: ArtifactsService) {}

  @Get()
  async list(
    @Query('owner_type') ownerType: string,
    @Query('owner_id') ownerId: string,
  ) {
    const items = await this.service.list(ownerType, ownerId);
    return { data: items };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const item = await this.service.get(id);
    return { data: item };
  }

  @Get(':id/view')
  async view(@Param('id') id: string, @Res() res: Response) {
    const { url, mime_type } = await this.service.presignedUrl(id, true);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(502).json({ error: { code: 'PROXY_ERROR', message: 'failed to fetch artifact' } });
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (['content-type', 'content-length', 'cache-control', 'etag'].includes(k)) headers[k] = v;
      });
      if (!headers['content-type']) headers['content-type'] = mime_type;
      res.writeHead(200, headers);
      const reader = response.body?.getReader();
      if (reader) {
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(value);
          }
        };
        pump().catch(() => res.end());
      } else {
        res.end();
      }
    } catch {
      res.status(502).json({ error: { code: 'PROXY_ERROR', message: 'failed to proxy artifact' } });
    }
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const { url, filename, mime_type } = await this.service.presignedUrl(id, false);
    try {
      // No extra query params: a presigned URL's signature covers its query string, and
      // appending a response-content-disposition override after signing makes MinIO
      // answer 403 SignatureDoesNotMatch. The attachment header is set on the proxy
      // response below instead, which achieves the same browser download.
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(502).json({ error: { code: 'PROXY_ERROR', message: 'failed to fetch artifact' } });
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (['content-type', 'content-length', 'content-disposition', 'cache-control'].includes(k)) headers[k] = v;
      });
      if (!headers['content-type']) headers['content-type'] = mime_type;
      if (!headers['content-disposition']) headers['content-disposition'] = `attachment; filename="${filename}"`;
      res.writeHead(200, headers);
      const reader = response.body?.getReader();
      if (reader) {
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(value);
          }
        };
        pump().catch(() => res.end());
      } else {
        res.end();
      }
    } catch {
      res.status(502).json({ error: { code: 'PROXY_ERROR', message: 'failed to proxy artifact' } });
    }
  }
}
