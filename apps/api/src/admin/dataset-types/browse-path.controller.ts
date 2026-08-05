import { Controller, Get, Query, HttpException } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import * as fs from 'fs';
import * as path from 'path';
import { getDataRoots } from '../../common/roots';

const ALLOWED_BASES = getDataRoots();

@Roles('ADMIN')
@Controller('admin/browse-path')
export class BrowsePathController {
  @Get()
  browsePath(@Query('path') inputPath: string) {
    if (!inputPath) {
      throw new HttpException({ error: { code: 'VALIDATION_FAILED', message: 'path required' } }, 400);
    }

    try {
      const resolved = path.resolve(inputPath);
      if (!this.isPathAllowed(resolved)) {
        throw new HttpException(
          { error: { code: 'VALIDATION_FAILED', message: 'path outside allowed directories' } },
          400,
        );
      }

      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new HttpException(
          { error: { code: 'VALIDATION_FAILED', message: 'path does not exist or is not a directory' } },
          400,
        );
      }

      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          fullPath: path.join(resolved, e.name),
        }))
        .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));

      return {
        data: {
          items,
          currentPath: resolved,
          parent: resolved === '/' ? null : path.dirname(resolved),
        },
      };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new HttpException({ error: { code: 'INTERNAL_ERROR', message: (e as Error).message } }, 500);
    }
  }

  private isPathAllowed(resolved: string): boolean {
    for (const base of ALLOWED_BASES) {
      if (!base) continue;
      const baseResolved = path.resolve(base);
      const relative = path.relative(baseResolved, resolved);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        return true;
      }
    }
    return false;
  }
}
