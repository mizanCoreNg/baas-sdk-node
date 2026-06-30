import axios, {
  type AxiosInstance,
  type AxiosError,
  type InternalAxiosRequestConfig,
} from 'axios';
import { randomUUID } from 'node:crypto';
import { BaasApiError } from './errors';
import { Configuration } from '../generated/configuration';

export type BaasEnvironment = 'test' | 'live' | 'staging';

export interface MizanBaasClientOptions {
  /** Partner API key — sent as the `X-API-Key` header on every request. */
  apiKey: string;
  /** 'test' (default), 'staging', or 'live'. Ignored if `baseUrl` is set. */
  environment?: BaasEnvironment;
  /** Explicit base URL override (wins over `environment`). */
  baseUrl?: string;
  /** Optional tenant id (sent as `X-Tenant-ID` for non-prod host routing). */
  tenant?: string;
  /** Retry cap for 429/5xx (default 3). */
  maxRetries?: number;
  /** Base backoff in ms for exponential backoff (default 200). */
  baseDelayMs?: number;
  /** Inject a pre-built axios instance (tests use this to mount a mock adapter). */
  axiosInstance?: AxiosInstance;
}

const BASE_URLS: Record<BaasEnvironment, string> = {
  test: 'https://test-api.mizancore.ng/api/v1',
  staging: 'https://staging-api.mizancore.ng/api/v1',
  live: 'https://api.mizancore.ng/api/v1',
};

const WRITE_METHODS = new Set(['post', 'put', 'patch']);

/** Internal marker tracking the per-request retry count. */
interface RetryableConfig extends InternalAxiosRequestConfig {
  __mizanRetryCount?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a Retry-After header into milliseconds, or null if unparseable. */
function parseRetryAfterMs(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

/**
 * Configured entry point for the MizanCore BaaS SDK — the hand-written
 * value-add layer over the OpenAPI-generated typescript-axios client.
 *
 * Wires an axios instance with:
 *   - `X-API-Key` auth header on every request (BaasAuthMiddleware reads
 *     X-API-Key; NOT X-Partner-Key).
 *   - Auto `Idempotency-Key` (crypto.randomUUID()) on POST/PUT/PATCH when the
 *     caller omitted one; a supplied key is preserved.
 *   - Exponential-backoff retry on 429 + 5xx honouring `Retry-After`.
 *   - Typed `BaasApiError` (+ Auth/Validation/RateLimit) mapping for the
 *     `{success,message,errors}` envelope.
 *
 * The same configured axios instance backs the generated `*Api` classes via
 * `api(ApiClass)`, so generated calls inherit auth + retry + idempotency +
 * typed errors.
 */
export class MizanBaasClient {
  readonly baseUrl: string;
  readonly axios: AxiosInstance;
  private readonly apiKey: string;
  private readonly tenant?: string;

  constructor(opts: MizanBaasClientOptions) {
    if (!opts.apiKey) {
      throw new Error('MizanBaasClient: `apiKey` is required.');
    }
    this.apiKey = opts.apiKey;
    this.tenant = opts.tenant;
    const env = opts.environment ?? 'test';
    this.baseUrl = (opts.baseUrl ?? BASE_URLS[env] ?? BASE_URLS.test).replace(/\/+$/, '');

    const maxRetries = opts.maxRetries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 200;

    const instance =
      opts.axiosInstance ??
      axios.create({ baseURL: this.baseUrl, headers: { Accept: 'application/json' } });

    if (!opts.axiosInstance) {
      // Only set baseURL/headers when we own the instance; a test-injected
      // instance keeps its own config (e.g. mock adapter baseURL).
      instance.defaults.baseURL = this.baseUrl;
    }

    // --- Request interceptor: auth + tenant + idempotency ---
    instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      config.headers.set('X-API-Key', this.apiKey);
      config.headers.set('User-Agent', 'mizancore-baas-js-sdk/0.1');
      if (this.tenant) {
        config.headers.set('X-Tenant-ID', this.tenant);
      }
      const method = (config.method ?? 'get').toLowerCase();
      if (WRITE_METHODS.has(method) && !config.headers.has('Idempotency-Key')) {
        config.headers.set('Idempotency-Key', randomUUID());
      }
      return config;
    });

    // --- Response interceptor: retry on 429/5xx, then map errors ---
    instance.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const config = error.config as RetryableConfig | undefined;
        const status = error.response?.status;

        const retriable =
          status === 429 || (status !== undefined && status >= 500) || status === undefined;

        if (config && retriable) {
          const attempt = config.__mizanRetryCount ?? 0;
          if (attempt < maxRetries) {
            config.__mizanRetryCount = attempt + 1;
            const retryAfter = parseRetryAfterMs(
              error.response?.headers?.['retry-after'] as string | undefined,
            );
            const backoff =
              retryAfter ?? baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);
            await sleep(backoff);
            return instance.request(config);
          }
        }

        // Map a non-2xx envelope to a typed error.
        if (error.response) {
          throw BaasApiError.fromResponse(error.response.status, error.response.data);
        }
        // Transport-level failure after retries exhausted: rethrow as-is.
        throw error;
      },
    );

    this.axios = instance;
  }

  /**
   * Build the OpenAPI-generated `Configuration` pre-loaded with the partner key
   * and resolved host. Pass `client.axios` as the third arg to a generated Api
   * class so it inherits all the interceptors.
   */
  configuration(): Configuration {
    return new Configuration({ apiKey: this.apiKey, basePath: this.baseUrl });
  }

  /**
   * Instantiate a generated `*Api` class wired to this client's configured
   * axios instance (auth + idempotency + retry + typed errors).
   *
   * @example
   *   const api = client.api(BaaSVirtualAccountsApi);
   */
  api<T>(
    ApiClass: new (
      configuration?: Configuration,
      basePath?: string,
      axios?: AxiosInstance,
    ) => T,
  ): T {
    return new ApiClass(this.configuration(), this.baseUrl, this.axios);
  }

  /** Convenience: GET a BaaS path, return the decoded body. */
  async get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.axios.get<T>(path.replace(/^\//, ''), { params });
    return res.data;
  }

  /**
   * Convenience: POST JSON. An `Idempotency-Key` is auto-added by the
   * interceptor unless `idempotencyKey` is supplied.
   */
  async post<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;
    const res = await this.axios.post<T>(path.replace(/^\//, ''), body ?? {}, { headers });
    return res.data;
  }
}
