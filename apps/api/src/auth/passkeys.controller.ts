import { Controller, Post, Get, Patch, Delete, Param, Body, Req, Res, HttpCode, HttpException, UseGuards } from '@nestjs/common';
import { AuthRateLimitGuard } from '../common/rate-limit/auth-rate-limit.guard';
import type { Request, Response } from 'express';
import { Public } from './decorators/public.decorator';
import { WebAuthnService } from './webauthn.service';
import { SessionService } from './session.service';
import { CsrfService } from './csrf.service';
import { ROLE_PERMISSIONS } from './permission.map';
import { errorCode } from '@model-trainer/shared-types';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { randomUUID } from 'crypto';

const COOKIE_SECURE =
  process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';

const WA_COOKIE = 'wa-flow';
const actorOf = (req: Request) => (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);

@Controller('auth/passkeys')
export class PasskeysController {
  constructor(
    private readonly webauthn: WebAuthnService,
    private readonly sessionService: SessionService,
    private readonly csrfService: CsrfService,
  ) {}

  private setFlowCookie(res: Response, challengeId: string) {
    res.cookie(WA_COOKIE, challengeId, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: 5 * 60 * 1000 });
  }

  // ── Registration (authenticated) ──
  @Post('register/options')
  @HttpCode(200)
  async registerOptions(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { options, challengeId } = await this.webauthn.registerOptions(actorOf(req).id);
    this.setFlowCookie(res, challengeId);
    return { data: options };
  }

  @Post('register/verify')
  @HttpCode(201)
  async registerVerify(@Req() req: Request, @Body() body: { response?: RegistrationResponseJSON; name?: string } = {}) {
    const challengeId = req.cookies?.[WA_COOKIE];
    if (!challengeId) throw badRequest('missing passkey flow cookie');
    if (!body.response) throw badRequest('response is required');
    return this.webauthn.registerVerify(actorOf(req).id, challengeId, body.response, body.name ?? 'Passkey', randomUUID());
  }

  // ── Authentication (passwordless login) ──
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('login/options')
  @HttpCode(200)
  async loginOptions(@Body() body: { username?: string } = {}, @Res({ passthrough: true }) res: Response) {
    const { options, challengeId } = await this.webauthn.loginOptions(body.username);
    this.setFlowCookie(res, challengeId);
    return { data: options };
  }

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('login/verify')
  @HttpCode(200)
  async loginVerify(
    @Req() req: Request,
    @Body() body: { response?: AuthenticationResponseJSON } = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const challengeId = req.cookies?.[WA_COOKIE];
    if (!challengeId) throw badRequest('missing passkey flow cookie');
    if (!body.response) throw badRequest('response is required');
    const ip = req.ip ?? req.socket?.remoteAddress ?? null;
    const ua = req.headers['user-agent'] ?? null;
    const { user, sessionId } = await this.webauthn.loginVerify(challengeId, body.response, ip, ua, randomUUID());

    const csrfToken = this.csrfService.generateToken();
    res.cookie(this.sessionService.cookieName(), sessionId, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' });
    res.cookie(this.csrfService.cookieName(), csrfToken, { httpOnly: false, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' });
    res.clearCookie(WA_COOKIE, { path: '/' });

    const permissions = ROLE_PERMISSIONS[user.role as keyof typeof ROLE_PERMISSIONS] ?? [];
    return {
      user: {
        id: user.id, username: user.username, display_name: user.display_name, email: user.email,
        role: user.role, status: user.status, must_change_password: user.must_change_password,
        last_login_at: user.last_login_at, permissions,
      },
      csrfToken,
    };
  }

  // ── Management (authenticated, own) ──
  @Get()
  list(@Req() req: Request) {
    return this.webauthn.list(actorOf(req).id);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: { name?: string } = {}, @Req() req: Request) {
    if (!body.name) throw badRequest('name is required');
    return this.webauthn.rename(actorOf(req).id, id, body.name, randomUUID());
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Request) {
    return this.webauthn.remove(actorOf(req).id, id, randomUUID());
  }
}
