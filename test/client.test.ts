import { describe, it, expect } from 'vitest';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { MizanBaasClient } from '../src/client';
import {
  BaasApiError,
  BaasAuthError,
  BaasValidationError,
  BaasRateLimitError,
} from '../src/errors';

interface Captured {
  url?: string;
  method?: string;
  headers: Record<string, string>;
}

/**
 * Build a client whose axios instance uses a custom adapter that records each
 * request and replays a scripted response queue. Lets us assert headers and
 * exercise retry/error paths with no network.
 */
function makeClient(
  responses: Array<{ status: number; data?: unknown; headers?: Record<string, string> }>,
  opts: Partial<{ maxRetries: number; tenant: string }> = {},
) {
  const captured: Captured[] = [];
  let i = 0;
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const headers: Record<string, string> = {};
    // AxiosHeaders → plain object
    const raw = config.headers as unknown as { toJSON?: () => Record<string, string> };
    Object.assign(headers, raw.toJSON ? raw.toJSON() : config.headers);
    captured.push({ url: config.url, method: config.method, headers });

    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const result = {
      data: r.data ?? {},
      status: r.status,
      statusText: '',
      headers: r.headers ?? {},
      config,
    };
    if (r.status >= 400) {
      // axios rejects on 4xx/5xx by default (validateStatus); emulate that.
      return Promise.reject(
        Object.assign(new Error(`Request failed with status ${r.status}`), {
          config,
          response: result,
          isAxiosError: true,
        }),
      );
    }
    return result;
  };

  const instance = axios.create({ adapter, baseURL: 'http://mock.local' });
  const client = new MizanBaasClient({
    apiKey: 'pk_test_123',
    axiosInstance: instance,
    baseDelayMs: 1,
    ...opts,
  });
  return { client, captured };
}

describe('auth header', () => {
  it('sends X-API-Key (not X-Partner-Key) on every request', async () => {
    const { client, captured } = makeClient([{ status: 200, data: { ok: true } }]);
    await client.get('/baas/virtual-accounts');
    expect(captured[0].headers['x-api-key'] ?? captured[0].headers['X-API-Key']).toBe('pk_test_123');
    expect(captured[0].headers['x-partner-key']).toBeUndefined();
  });

  it('sends X-Tenant-ID when tenant provided', async () => {
    const { client, captured } = makeClient([{ status: 200 }], { tenant: 'world.test.localhost' });
    await client.get('/baas/ping');
    const h = captured[0].headers;
    expect(h['x-tenant-id'] ?? h['X-Tenant-ID']).toBe('world.test.localhost');
  });
});

describe('idempotency key', () => {
  it('auto-adds an Idempotency-Key on POST when caller omits one', async () => {
    const { client, captured } = makeClient([{ status: 201, data: { id: 'va_1' } }]);
    await client.post('/baas/virtual-accounts', { customer_id: 'c1' });
    const key = captured[0].headers['idempotency-key'] ?? captured[0].headers['Idempotency-Key'];
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('preserves a caller-supplied Idempotency-Key', async () => {
    const { client, captured } = makeClient([{ status: 201 }]);
    await client.post('/baas/virtual-accounts', { customer_id: 'c1' }, 'my-key-abc');
    const key = captured[0].headers['idempotency-key'] ?? captured[0].headers['Idempotency-Key'];
    expect(key).toBe('my-key-abc');
  });

  it('does NOT add an Idempotency-Key on GET', async () => {
    const { client, captured } = makeClient([{ status: 200 }]);
    await client.get('/baas/virtual-accounts');
    expect(captured[0].headers['idempotency-key']).toBeUndefined();
    expect(captured[0].headers['Idempotency-Key']).toBeUndefined();
  });
});

describe('error mapping', () => {
  it('maps 401 → BaasAuthError', async () => {
    const { client } = makeClient([{ status: 401, data: { success: false, message: 'Unauthenticated.' } }]);
    await expect(client.get('/x')).rejects.toMatchObject({
      constructor: BaasAuthError,
      httpStatus: 401,
      message: 'Unauthenticated.',
    });
  });

  it('maps 422 → BaasValidationError carrying field errors', async () => {
    const { client } = makeClient([
      {
        status: 422,
        data: { success: false, message: 'Validation failed.', errors: { customer_id: ['required'] } },
      },
    ]);
    try {
      await client.post('/x', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BaasValidationError);
      const err = e as BaasValidationError;
      expect(err.httpStatus).toBe(422);
      expect(err.errors).toEqual({ customer_id: ['required'] });
    }
  });

  it('maps a generic 400 → BaasApiError', async () => {
    const { client } = makeClient([{ status: 400, data: { success: false, message: 'Bad.' } }]);
    await expect(client.get('/x')).rejects.toBeInstanceOf(BaasApiError);
  });
});

describe('retry / backoff', () => {
  it('retries on 429 then succeeds, surfacing the success body', async () => {
    const { client, captured } = makeClient([
      { status: 429, headers: { 'retry-after': '0' }, data: { message: 'slow down' } },
      { status: 200, data: { ok: true } },
    ]);
    const out = await client.get<{ ok: boolean }>('/x');
    expect(out.ok).toBe(true);
    expect(captured.length).toBe(2);
  });

  it('gives up after maxRetries on persistent 429 → BaasRateLimitError', async () => {
    const { client, captured } = makeClient(
      [{ status: 429, headers: { 'retry-after': '0' }, data: { message: 'nope' } }],
      { maxRetries: 2 },
    );
    await expect(client.get('/x')).rejects.toBeInstanceOf(BaasRateLimitError);
    // 1 initial + 2 retries = 3 attempts
    expect(captured.length).toBe(3);
  });

  it('retries on 503 then succeeds', async () => {
    const { client, captured } = makeClient([
      { status: 503, data: {} },
      { status: 200, data: { ok: true } },
    ]);
    await client.get('/x');
    expect(captured.length).toBe(2);
  });
});

describe('config', () => {
  it('resolves base URL by environment', () => {
    const live = new MizanBaasClient({ apiKey: 'k', environment: 'live' });
    expect(live.baseUrl).toBe('https://api.mizancore.ng/api/v1');
    const test = new MizanBaasClient({ apiKey: 'k' });
    expect(test.baseUrl).toBe('https://test-api.mizancore.ng/api/v1');
  });

  it('throws when apiKey is missing', () => {
    // @ts-expect-error intentional
    expect(() => new MizanBaasClient({})).toThrow();
  });
});
