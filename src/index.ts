/**
 * @mizancore/baas-sdk — Official JS/TS SDK for the MizanCore BaaS API.
 *
 * The wire-level client is generated from the BaaS OpenAPI spec
 * (typescript-axios, under ./generated). This module re-exports the
 * hand-written value-add layer (configured client, typed errors, webhook
 * verification) plus the generated Api classes and models.
 */

export { MizanBaasClient } from './client';
export type {
  MizanBaasClientOptions,
  BaasEnvironment,
} from './client';

export {
  BaasApiError,
  BaasAuthError,
  BaasValidationError,
  BaasRateLimitError,
} from './errors';
export type { ErrorEnvelope } from './errors';

export { MizanWebhooks } from './webhooks';

// Re-export the generated typed API surface (Api classes, models, Configuration).
export * from '../generated/api';
export { Configuration } from '../generated/configuration';
