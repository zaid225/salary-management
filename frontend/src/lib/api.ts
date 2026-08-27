// One place that talks to the Worker. Every request carries the Clerk
// session token and the active organization id (design spec §5.7) - a
// caller never assembles those headers itself.

const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

export interface ApiErrorShape {
  error: { message: string; code?: string; statusCode: number };
}

export class ApiError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

export type TokenGetter = () => Promise<string | null>;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Raw text body (CSV import) - sent as-is with the given content type. */
  rawBody?: { body: string; contentType: string };
  orgId?: string | null;
  signal?: AbortSignal;
}

async function parseError(res: Response): Promise<never> {
  // The Worker always answers with { error: { message, statusCode } }
  // (error-handling-logging.md rule 1). Anything else means the request
  // never reached it - a proxy, a CORS rejection, a cold-start crash.
  let message = `Request failed (${res.status})`;
  try {
    const json = (await res.json()) as Partial<ApiErrorShape>;
    if (json.error?.message) message = json.error.message;
  } catch {
    // Non-JSON error body; keep the status-derived message.
  }
  throw new ApiError(message, res.status);
}

export function createApiClient(getToken: TokenGetter) {
  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const token = await getToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (opts.orgId) headers["X-Org-Id"] = opts.orgId;

    let body: string | undefined;
    if (opts.rawBody) {
      headers["Content-Type"] = opts.rawBody.contentType;
      body = opts.rawBody.body;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: opts.signal,
    });

    if (!res.ok) await parseError(res);
    if (res.status === 204) return undefined as T;

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/csv")) return (await res.text()) as T;
    return (await res.json()) as T;
  }

  return { request, apiUrl: API_URL };
}

export type ApiClient = ReturnType<typeof createApiClient>;
