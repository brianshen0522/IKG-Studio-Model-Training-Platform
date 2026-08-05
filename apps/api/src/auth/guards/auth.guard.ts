import { Injectable, CanActivate, ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { SessionService } from '../session.service';
import { ROLE_PERMISSIONS, type PermissionCode } from '../permission.map';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { CsrfService } from '../csrf.service';
import { errorCode } from '@model-trainer/shared-types';
import type { UserRole } from '@model-trainer/db';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const MUST_CHANGE_PASSWORD_ALLOWED = new Set([
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/change-password',
  'POST /api/v1/auth/logout',
]);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessionService: SessionService,
    private readonly csrfService: CsrfService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const method = request.method as string;
    const path = request.route?.path ?? request.path ?? '';

    const fullPath = `${method} ${path}`;

    if (isPublic) {
      return true;
    }

    const token = this.sessionService.extractToken(request);
    if (!token) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_SESSION_EXPIRED, message: 'Session expired', requestId: '' } },
        401,
      );
    }

    const session = await this.sessionService.validate(token);
    if (!session) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_SESSION_EXPIRED, message: 'Session expired', requestId: '' } },
        401,
      );
    }

    RequestContextService.setUser(session.userId, session.role);

    if (session.mustChangePassword) {
      if (!MUST_CHANGE_PASSWORD_ALLOWED.has(fullPath)) {
        throw new HttpException(
          { error: { code: errorCode.AUTH_PASSWORD_CHANGE_REQUIRED, message: 'Password change required', requestId: '' } },
          403,
        );
      }
    }

    if (WRITE_METHODS.has(method)) {
      this.validateCsrf(request);
    }

    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (roles && roles.length > 0) {
      if (!roles.includes(session.role as UserRole)) {
        throw new HttpException(
          { error: { code: errorCode.AUTH_PERMISSION_DENIED, message: 'Insufficient role', requestId: '' } },
          403,
        );
      }
    }

    const permissions = this.reflector.getAllAndOverride<PermissionCode[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (permissions && permissions.length > 0) {
      const userPerms = ROLE_PERMISSIONS[session.role as UserRole] ?? [];
      const hasAll = permissions.every((p) => userPerms.includes(p));
      if (!hasAll) {
        throw new HttpException(
          { error: { code: errorCode.AUTH_PERMISSION_DENIED, message: 'Insufficient permissions', requestId: '' } },
          403,
        );
      }
    }

    request.user = {
      id: session.userId,
      role: session.role,
      mustChangePassword: session.mustChangePassword,
    };

    return true;
  }

  private validateCsrf(request: Record<string, unknown>): void {
    const token = (request.headers as Record<string, string>)?.[this.csrfService.headerName()];
    if (!token || !this.csrfService.validateToken(token)) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_CSRF_TOKEN_INVALID, message: 'Invalid CSRF token', requestId: '' } },
        403,
      );
    }
  }
}
