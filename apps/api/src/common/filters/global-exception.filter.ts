import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { ZodError } from 'zod';
import { errorCode, type ErrorCode, type ErrorEnvelope } from '@model-trainer/shared-types';
import { StructuredLoggerService } from '../logger/structured-logger.service';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private logger = new StructuredLoggerService();

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as unknown as Record<string, unknown>).requestId as string || 'unknown';

    let status = 500;
    let code: ErrorCode = errorCode.INTERNAL_ERROR;
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof ZodError) {
      status = 400;
      code = errorCode.VALIDATION_FAILED;
      message = 'Request validation failed.';
      const fields: Record<string, string> = {};
      for (const issue of exception.issues) {
        fields[issue.path.join('.')] = issue.message;
      }
      details = { fields };
    } else if (exception instanceof BadRequestException) {
      status = 400;
      code = errorCode.VALIDATION_FAILED;
      message = exception.message;
      const resp = exception.getResponse();
      if (typeof resp === 'object' && resp !== null) {
        const r = resp as Record<string, unknown>;
        if (r.message) {
          details = { fields: r.message };
        }
        if (r.details) {
          details = r.details as Record<string, unknown>;
        }
      }
    } else if (exception instanceof NotFoundException) {
      status = 404;
      code = errorCode.RESOURCE_NOT_FOUND;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'object' && resp !== null) {
        const r = resp as Record<string, unknown>;
        if (r.error && typeof r.error === 'object') {
          const e = r.error as Record<string, unknown>;
          code = (e.code as ErrorCode) || errorCode.INTERNAL_ERROR;
          message = (e.message as string) || exception.message;
          details = e.details as Record<string, unknown> | undefined;
        } else {
          code = errorCode.INTERNAL_ERROR;
          message = exception.message;
        }
      } else {
        if (status === 503) {
          code = errorCode.DEPENDENCY_UNAVAILABLE;
        }
        message = exception.message;
      }
    }

    if (status >= 500) {
      // Unhandled errors: capture the stack to stderr (structured logger fields are whitelisted).
      // eslint-disable-next-line no-console
      console.error('[unhandled]', exception instanceof Error ? exception.stack : exception);
    }

    this.logger.error(message, {
      error_code: code,
      request_id: requestId,
    });

    const body: ErrorEnvelope = {
      error: { code, message, details, requestId },
    };

    response.status(status).json(body);
  }
}
