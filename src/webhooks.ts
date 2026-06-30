import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature verification for MizanCore BaaS partner webhooks.
 *
 * Backend signer — source of truth:
 *   server/app/Domains/BaaS/Services/WebhookDispatchService.php:165-184
 *     hash_hmac('sha256', json_encode($payload, JSON_UNESCAPED_SLASHES), $secret)
 *   -> lowercase hex, delivered in the `X-Webhook-Signature` header,
 *      verified with hash_equals() (timing-safe).
 *
 * RAW-BYTES CONTRACT (cross-language correctness)
 * -----------------------------------------------
 * The string the backend signs IS the exact byte sequence it writes to the
 * HTTP response body. Therefore the robust, language-agnostic way to verify is
 * to HMAC the RAW RECEIVED REQUEST BODY BYTES — never a re-encode of the parsed
 * object. Re-encoding is fragile across languages: PHP `json_encode` with only
 * JSON_UNESCAPED_SLASHES still escapes non-ASCII as \uXXXX and emits compact
 * separators; JS `JSON.stringify` does NOT escape non-ASCII; Python
 * `json.dumps` adds spaces by default. Any of those differences flips a valid
 * signature to invalid. So: pass the raw body exactly as received.
 *
 * In Express, capture the raw body (e.g. `express.json({ verify: (req,_res,buf)=>{ req.rawBody = buf; } })`
 * or a raw body parser) and pass `req.rawBody`. Never pass `JSON.stringify(req.body)`.
 */
export class MizanWebhooks {
  /**
   * Verify an inbound webhook's `X-Webhook-Signature` against the shared secret.
   *
   * @param rawBody         The RAW request body, exactly as received (string or Buffer).
   * @param signatureHeader The `X-Webhook-Signature` header value (lowercase hex).
   * @param secret          The partner webhook signing secret.
   */
  static verify(
    rawBody: string | Buffer,
    signatureHeader: string,
    secret: string,
  ): boolean {
    if (!signatureHeader || !secret) {
      return false;
    }

    const expected = MizanWebhooks.sign(rawBody, secret);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signatureHeader, 'utf8');

    // timingSafeEqual throws if lengths differ; guard first so a length
    // mismatch is a constant-time-ish `false` rather than an exception.
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }

  /**
   * Compute the `X-Webhook-Signature` (lowercase hex HMAC-SHA256) for a raw
   * body. Used by tests to produce valid signatures and by any caller that
   * needs to re-sign. HMACs the raw bytes — no re-encoding.
   */
  static sign(rawBody: string | Buffer, secret: string): string {
    return createHmac('sha256', secret).update(rawBody).digest('hex');
  }
}
