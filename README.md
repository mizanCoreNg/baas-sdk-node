# @mizancore/baas-sdk

Official JavaScript/TypeScript SDK for the **MizanCore Banking-as-a-Service
(BaaS) API**. A hand-written value-add layer (auth, idempotency, retry, typed
errors, webhook verification) over an OpenAPI-generated `typescript-axios`
client (under [`generated/`](./generated)).

## Quickstart

```ts
import { MizanBaasClient } from '@mizancore/baas-sdk';

const client = new MizanBaasClient({ apiKey: 'pk_test_...', environment: 'test' });
const account = await client.post('/baas/virtual-accounts', { customer_id: 'c_123' });
// X-API-Key + an auto Idempotency-Key are attached; 429/5xx are retried.
```

## What the SDK adds

| Concern | Behaviour |
|---|---|
| **Auth** | `X-API-Key` header on every request (resolves test/staging/live base URL by `environment`). |
| **Idempotency** | Auto `Idempotency-Key` (`crypto.randomUUID()`) on POST/PUT/PATCH; a caller-supplied key is preserved; never added on GET. |
| **Retries** | Exponential backoff with jitter on `429` + `5xx`, honouring `Retry-After`. |
| **Typed errors** | Non-2xx `{success,message,errors}` → `BaasApiError` (+ `BaasAuthError`/`BaasValidationError`/`BaasRateLimitError`) with `httpStatus`, `errorCode`, `errors`. |
| **Webhooks** | `MizanWebhooks.verify(rawBody, signatureHeader, secret)` — HMAC-SHA256 over the **raw body bytes**, timing-safe compare. |

## Generated API classes

```ts
import { MizanBaasClient, BaaSVirtualAccountsApi } from '@mizancore/baas-sdk';

const client = new MizanBaasClient({ apiKey: 'pk_test_...' });
const api = client.api(BaaSVirtualAccountsApi); // inherits auth + retry + idempotency
```

## Webhook verification (raw bytes — important)

```ts
import express from 'express';
import { MizanWebhooks } from '@mizancore/baas-sdk';

const app = express();
// Capture the RAW body — do NOT verify a re-serialized object.
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

app.post('/webhooks/mizan', (req, res) => {
  const ok = MizanWebhooks.verify(
    (req as any).rawBody,                 // raw bytes exactly as received
    req.header('X-Webhook-Signature') ?? '',
    process.env.MIZAN_WEBHOOK_SECRET!,
  );
  if (!ok) return res.status(401).end();
  res.status(204).end();
});
```

## Develop

```bash
npm install
npm test         # vitest
npm run build    # ESM + CJS + .d.ts via tsup
```

Regenerate the wire client from the OpenAPI spec with `../generate.sh` (run from
the repo root).
