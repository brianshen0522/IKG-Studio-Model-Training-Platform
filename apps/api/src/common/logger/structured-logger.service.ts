import { LoggerService, LogLevel } from '@nestjs/common';
import { RequestContextService } from '../request-context/request-context.service';

type LogEntry = {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  request_id?: string;
  correlation_id?: string;
  error_code?: string;
  duration_ms?: number;
};

export class StructuredLoggerService implements LoggerService {
  private logLevels: Set<string> = new Set(['log', 'error', 'warn', 'debug', 'verbose']);

  private formatEntry(level: string, message: unknown, ...optionalParams: unknown[]): LogEntry {
    const ctx = RequestContextService.get();
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service: 'backend',
      message: typeof message === 'string' ? message : JSON.stringify(message),
    };
    if (ctx?.requestId) {
      entry.request_id = ctx.requestId;
    }
    if (optionalParams.length > 0) {
      const context = optionalParams[0];
      if (typeof context === 'object' && context !== null) {
        const ext = context as Record<string, unknown>;
        entry.correlation_id = ext.correlation_id as string | undefined;
        entry.error_code = ext.error_code as string | undefined;
        entry.duration_ms = ext.duration_ms as number | undefined;
      }
    }
    return entry;
  }

  log(message: unknown, ...optionalParams: unknown[]) {
    if (!this.logLevels.has('log')) return;
    console.log(JSON.stringify(this.formatEntry('INFO', message, ...optionalParams)));
  }

  error(message: unknown, ...optionalParams: unknown[]) {
    if (!this.logLevels.has('error')) return;
    console.error(JSON.stringify(this.formatEntry('ERROR', message, ...optionalParams)));
    const trace = optionalParams[1];
    if (typeof trace === 'string') {
      console.error(trace);
    }
  }

  warn(message: unknown, ...optionalParams: unknown[]) {
    if (!this.logLevels.has('warn')) return;
    console.warn(JSON.stringify(this.formatEntry('WARN', message, ...optionalParams)));
  }

  debug(message: unknown, ...optionalParams: unknown[]) {
    if (!this.logLevels.has('debug')) return;
    console.debug(JSON.stringify(this.formatEntry('DEBUG', message, ...optionalParams)));
  }

  verbose(message: unknown, ...optionalParams: unknown[]) {
    if (!this.logLevels.has('verbose')) return;
    console.log(JSON.stringify(this.formatEntry('TRACE', message, ...optionalParams)));
  }

  setLogLevels(levels: LogLevel[]) {
    this.logLevels = new Set(levels);
  }
}
