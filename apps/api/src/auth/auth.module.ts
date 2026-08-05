import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { AuthController } from './auth.controller';
import { PasskeysController } from './passkeys.controller';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { SystemSettingsService } from './system-settings.service';
import { CsrfService } from './csrf.service';
import { WebAuthnService } from './webauthn.service';
import { AuthGuard } from './guards/auth.guard';

@Module({
  imports: [AuditModule, RateLimitModule],
  controllers: [AuthController, PasskeysController],
  providers: [
    PasswordService,
    SessionService,
    SystemSettingsService,
    CsrfService,
    WebAuthnService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PasswordService, SessionService, SystemSettingsService, CsrfService],
})
export class AuthModule {}
