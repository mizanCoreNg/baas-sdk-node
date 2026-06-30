import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { MizanWebhooks } from '../src/webhooks';

/**
 * Reproduce the BACKEND signature exactly the way PHP does it
 * (server/app/Domains/BaaS/Services/WebhookDispatchService.php:165-184):
 *   hash_hmac('sha256', <exact body bytes>, $secret) -> lowercase hex.
 *
 * The body string used here IS the exact byte sequence the backend writes to
 * the HTTP response (PHP json_encode with JSON_UNESCAPED_SLASHES: compact
 * separators, slashes NOT escaped, non-ASCII escaped as \uXXXX). Verifying by
 * HMAC-ing the raw received bytes reproduces it without re-encoding.
 */
const SECRET = 'whsec_partner_shared_secret';

// What the backend would have on the wire for {"event":"va.credited","amount":150050}
const BACKEND_BODY = '{"event":"va.credited","amount":150050}';

function backendSignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('MizanWebhooks.verify (raw-bytes contract)', () => {
  it('accepts a signature produced exactly like the PHP backend', () => {
    const sig = backendSignature(BACKEND_BODY, SECRET);
    expect(MizanWebhooks.verify(BACKEND_BODY, sig, SECRET)).toBe(true);
  });

  it('accepts a Buffer raw body identically', () => {
    const sig = backendSignature(BACKEND_BODY, SECRET);
    expect(MizanWebhooks.verify(Buffer.from(BACKEND_BODY, 'utf8'), sig, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = backendSignature(BACKEND_BODY, SECRET);
    const tampered = '{"event":"va.credited","amount":999999}';
    expect(MizanWebhooks.verify(tampered, sig, SECRET)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const sig = backendSignature(BACKEND_BODY, SECRET);
    expect(MizanWebhooks.verify(BACKEND_BODY, sig, 'wrong_secret')).toBe(false);
  });

  it('rejects empty signature / empty secret', () => {
    expect(MizanWebhooks.verify(BACKEND_BODY, '', SECRET)).toBe(false);
    expect(MizanWebhooks.verify(BACKEND_BODY, 'abc', '')).toBe(false);
  });

  it('handles non-ASCII payloads via raw bytes (no re-encode mismatch)', () => {
    // Backend body with a unicode name. As raw bytes, both sides HMAC the same.
    const body = '{"name":"Olúwaséun","city":"Lagos"}';
    const sig = backendSignature(body, SECRET);
    expect(MizanWebhooks.verify(body, sig, SECRET)).toBe(true);
  });
});

describe('MizanWebhooks.sign', () => {
  it('produces lowercase hex matching the backend HMAC', () => {
    const sig = MizanWebhooks.sign(BACKEND_BODY, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(backendSignature(BACKEND_BODY, SECRET));
  });
});
