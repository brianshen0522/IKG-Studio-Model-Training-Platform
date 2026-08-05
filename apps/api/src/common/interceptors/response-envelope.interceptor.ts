import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { SuccessEnvelope } from '@model-trainer/shared-types';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<SuccessEnvelope> {
    return next.handle().pipe(
      map((data) => {
        // Pass through values already shaped as an envelope ({ error } or { data, meta? }).
        if (data && typeof data === 'object' && ('error' in data || 'data' in data)) {
          return data;
        }
        const envelope: SuccessEnvelope = { data };
        return envelope;
      }),
    );
  }
}
