import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { StructuredLoggerService } from './common/logger/structured-logger.service';
import { loadEnv } from './config/config.schema';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLoggerService(),
  });

  app.use(cookieParser());
  // Trust exactly two proxy hops (tls-proxy terminates TLS, then web's nginx) so
  // `req.ip` is the real client IP from X-Forwarded-For (used by rate limiting + audit)
  // and cannot be spoofed by the client. web's nginx preserves X-Forwarded-Proto from
  // tls-proxy (see deploy/nginx/nginx.conf) so req.secure reflects the real scheme too.
  app.getHttpAdapter().getInstance().set('trust proxy', 2);
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });

  await app.listen(env.PORT);
}
bootstrap();
