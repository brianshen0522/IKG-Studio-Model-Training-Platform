import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
  userRole?: string;
}

export class RequestContextService {
  private static als = new AsyncLocalStorage<RequestContext>();

  static run(context: RequestContext, callback: () => void) {
    this.als.run(context, callback);
  }

  static get(): RequestContext | undefined {
    return this.als.getStore();
  }

  static getRequestId(): string {
    return this.get()?.requestId || 'unknown';
  }

  static getUserId(): string | undefined {
    return this.get()?.userId;
  }

  static setUser(userId: string, userRole: string): void {
    const ctx = this.get();
    if (ctx) {
      ctx.userId = userId;
      ctx.userRole = userRole;
    }
  }
}
