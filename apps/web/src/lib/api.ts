const BASE = '/api/v1';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

interface SuccessEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}
interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export interface PageMeta {
  page: number;
  size: number;
  total: number;
  totalPages: number;
}

async function parse<T>(res: Response): Promise<SuccessEnvelope<T>> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = (body as ErrorEnvelope | null)?.error;
    throw new ApiError(err?.code ?? 'UNKNOWN', err?.message ?? res.statusText, res.status);
  }
  return (body ?? { data: null }) as SuccessEnvelope<T>;
}

/** GET a resource and return the unwrapped `data`. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  return (await parse<T>(res)).data;
}

/**
 * GET a list endpoint and return both `data` and pagination `meta`.
 * Tolerant of two envelope shapes: `{ data: [...], meta }` and `{ data: { items: [...], ...page } }`.
 */
export async function apiGetList<T>(path: string): Promise<{ data: T[]; meta: PageMeta }> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  const env = (await parse<unknown>(res)) as { data?: unknown; meta?: Partial<PageMeta> };
  const raw = env.data;
  let data: T[] = [];
  let meta: Partial<PageMeta> = env.meta ?? {};
  if (Array.isArray(raw)) {
    data = raw as T[];
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
    data = (raw as { items: T[] }).items;
    meta = { ...(raw as Partial<PageMeta>), ...meta };
  }
  return {
    data,
    meta: {
      page: meta.page ?? 1,
      size: meta.size ?? data.length,
      total: meta.total ?? data.length,
      totalPages: meta.totalPages ?? 1,
    },
  };
}

/** Perform a mutating request. The backend requires `csrfToken` on all writes. */
export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  csrfToken?: string | null,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await parse<T>(res)).data;
}

/** The CSRF token lives in a non-httpOnly cookie so it survives page reloads. */
export function readCsrfCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
