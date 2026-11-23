export interface ApiMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api/v1';

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = readCookie('teamos_csrf');
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: ApiError['details']; requestId?: string } } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(
      res.status,
      payload.error?.code ?? 'UNKNOWN',
      payload.error?.message ?? `Request failed (${res.status})`,
      payload.error?.details,
      payload.error?.requestId,
    );
  }
  return res;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await request(path, opts.method ?? 'GET', opts.body);
  const json = (await res.json()) as { data: T };
  return json.data;
}

export async function apiPage<T>(path: string): Promise<{ items: T[]; meta: ApiMeta }> {
  const res = await request(path, 'GET');
  const json = (await res.json()) as { data: T[]; meta: ApiMeta };
  return { items: json.data, meta: json.meta };
}

/** Map server-side field errors onto a react-hook-form `setError`. Returns true if any field matched. */
export function applyFieldErrors(
  err: unknown,
  setError: (name: never, error: { message: string }) => void,
  fields: string[],
): boolean {
  if (!(err instanceof ApiError) || !err.details) return false;
  let any = false;
  for (const d of err.details) {
    if (fields.includes(d.path)) {
      setError(d.path as never, { message: d.message });
      any = true;
    }
  }
  return any;
}

/** Upload a raw binary body (e.g. audio). Same CSRF + error handling as JSON calls. */
export async function apiUpload<T>(path: string, file: Blob, contentType: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': contentType, 'X-CSRF-Token': readCookie('teamos_csrf') },
      credentials: 'same-origin',
      body: file,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string } } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON */
    }
    throw new ApiError(res.status, payload.error?.code ?? 'UNKNOWN', payload.error?.message ?? `Upload failed (${res.status})`);
  }
  return ((await res.json()) as { data: T }).data;
}
