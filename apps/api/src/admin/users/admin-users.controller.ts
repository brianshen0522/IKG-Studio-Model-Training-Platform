import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, Req,
  HttpCode, HttpException,
} from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import type { UserRole, UserStatus } from '@model-trainer/db';
import { AdminUsersService } from './admin-users.service';
import { SessionService } from '../../auth/session.service';
import { AdminAuditService } from '../../audit/admin-audit.service';

@Roles('ADMIN')
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly adminUsersService: AdminUsersService,
    private readonly sessionService: SessionService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Get(':id/history')
  async history(@Param('id') id: string) {
    return { data: await this.adminAudit.historyForResource('USER', id) };
  }

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('role') role?: UserRole,
    @Query('status') status?: UserStatus,
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: 'asc' | 'desc',
  ) {
    const result = await this.adminUsersService.list({
      q,
      role,
      status,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      size: Math.min(Math.max(parseInt(size ?? '25', 10) || 25, 1), 100),
      sort,
      order,
    });

    return {
      data: result.items,
      meta: {
        page: result.page,
        size: result.size,
        total: result.total,
        totalPages: Math.ceil(result.total / result.size),
      },
    };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: {
      username?: string;
      display_name?: string;
      email?: string | null;
      role?: UserRole;
      password_mode?: 'MANUAL' | 'GENERATED';
      password?: string;
    } = {},
    @Req() req: Request,
  ) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };

    if (!body.username || !body.display_name || !body.role || !body.password_mode) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'username, display_name, role, password_mode are required', requestId: '' } },
        400,
      );
    }

    if (!['MANUAL', 'GENERATED'].includes(body.password_mode)) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'password_mode must be MANUAL or GENERATED', requestId: '' } },
        400,
      );
    }

    if (!['ADMIN', 'USER'].includes(body.role)) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'role must be ADMIN or USER', requestId: '' } },
        400,
      );
    }

    const { user, tempPassword } = await this.adminUsersService.create(
      {
        username: body.username,
        display_name: body.display_name,
        email: body.email ?? null,
        role: body.role,
        password_mode: body.password_mode,
        password: body.password,
      },
      actor,
    );

    const data: Record<string, unknown> = { user };
    if (tempPassword) {
      data.temporary_password = tempPassword;
    }
    return { data };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const user = await this.adminUsersService.findById(id);
    return { data: user };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: {
      display_name?: string;
      email?: string | null;
      role?: UserRole;
      row_version?: number;
    } = {},
    @Req() req: Request,
  ) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };

    if (body.row_version === undefined || body.row_version === null) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'row_version is required', requestId: '' } },
        400,
      );
    }

    const updated = await this.adminUsersService.update(id, {
      display_name: body.display_name,
      email: body.email,
      role: body.role,
      row_version: body.row_version,
    }, actor);

    return { data: updated };
  }

  @Post(':id/disable')
  @HttpCode(200)
  async disable(
    @Param('id') id: string,
    @Body() body: { reason?: string } = {},
    @Req() req: Request,
  ) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };
    const user = await this.adminUsersService.disable(id, { reason: body.reason }, actor);
    return { data: user };
  }

  @Post(':id/enable')
  @HttpCode(200)
  async enable(
    @Param('id') id: string,
    @Body() body: { reason?: string } = {},
    @Req() req: Request,
  ) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };
    const user = await this.adminUsersService.enable(id, { reason: body.reason }, actor);
    return { data: user };
  }

  @Post(':id/unlock')
  @HttpCode(200)
  async unlock(
    @Param('id') id: string,
    @Body() body: { reason?: string } = {},
    @Req() req: Request,
  ) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };
    const user = await this.adminUsersService.unlock(id, { reason: body.reason }, actor);
    return { data: user };
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(
    @Param('id') id: string,
    @Body() body: { new_password?: string } = {},
    @Req() req: Request,
  ) {
    if (!body.new_password || body.new_password.length < 8) {
      throw new HttpException(
        { error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters', requestId: '' } },
        400,
      );
    }
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };
    await this.adminUsersService.setPassword(id, body.new_password, actor);
    return { data: { id } };
  }

  @Get(':id/sessions')
  async getSessions(@Param('id') id: string) {
    const sessions = await this.adminUsersService.getSessions(id);
    return {
      data: sessions.map((s) => ({
        id: s.id,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        idle_expires_at: s.idle_expires_at,
        absolute_expires_at: s.absolute_expires_at,
        revoked_at: s.revoked_at,
        ip_address: s.ip_address,
        user_agent: s.user_agent,
        is_active: s.is_active,
      })),
    };
  }

  @Delete(':id/sessions/:sessionId')
  @HttpCode(200)
  async deleteSession(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };
    await this.adminUsersService.deleteSession(id, sessionId, actor);
    return { data: { message: 'Session revoked' } };
  }

  @Post(':id/revoke-all-sessions')
  @HttpCode(200)
  async revokeAllSessions(
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };
    const result = await this.adminUsersService.revokeAllSessions(id, actor);
    return { data: result };
  }
}
