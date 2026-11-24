<!--
  ============================================================================
  GENERATED RELEASE MIRROR - DO NOT EDIT HERE.
  Source of truth: github.com/bagdock/bagdock (monorepo), packages/worker-sdk.
  Pull requests to this repository cannot be merged and are auto-closed.
  Issues are welcome. Changes land in the monorepo and are re-synced here.
  ============================================================================
-->

```
  ----++                                ----++                    ---+++     
  ---+++                                ---++                     ---++      
 ----+---     -----     ---------  --------++ ------     -----   ----++----- 
 ---------+ --------++----------++--------+++--------+ --------++---++---++++
 ---+++---++ ++++---++---+++---++---+++---++---+++---++---++---++------++++  
----++ ---++--------++---++----++---+++---++---++ ---+---++     -------++    
----+----+---+++---++---++----++---++----++---++---+++--++ --------+---++   
---------++--------+++--------+++--------++ -------+++ -------++---++----++  
 +++++++++   +++++++++- +++---++   ++++++++    ++++++    ++++++  ++++  ++++  
                     --------+++                                             
                       +++++++                                               
```

# @bagdock/worker-sdk

Platform SDK for building Bagdock adapter workers on Cloudflare Workers — lifecycle hooks, typed comms contract, webhook verification primitives, and error boundaries.

[![npm version](https://img.shields.io/npm/v/@bagdock/worker-sdk.svg)](https://www.npmjs.com/package/@bagdock/worker-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Install

```bash
npm install @bagdock/worker-sdk
```

```bash
yarn add @bagdock/worker-sdk
```

```bash
pnpm add @bagdock/worker-sdk
```

```bash
bun add @bagdock/worker-sdk
```

Requires `@cloudflare/workers-types` as a peer dependency.

## Quick start

```typescript
import { createCommsWorker } from '@bagdock/worker-sdk'
import type { HandlerContext } from '@bagdock/worker-sdk'

interface Env {
  TELNYX_API_KEY: string
  OPERATOR_CONFIG?: KVNamespace
}

async function handleSmsSend(ctx: HandlerContext<Env>): Promise<Response> {
  const { to, body } = await ctx.request.json() as { to: string; body: string }
  // Call your vendor's SMS API using ctx.env for secrets
  return Response.json({ id: crypto.randomUUID(), status: 'queued' })
}

export default createCommsWorker<Env>({
  capabilities: ['sms'],

  async onInstall(ctx) {
    // Provision vendor resources, store per-installation state
    await ctx.store.put('api_key', 'vendor-key-from-provisioning')
    return { installation_state: { provisioned: true } }
  },

  async onUninstall(ctx) {
    // Clean up vendor resources
  },

  routes: {
    'sms/send': handleSmsSend,
  },
})
```

## What the SDK handles

| Concern | You write | SDK handles |
|---------|-----------|-------------|
| **Lifecycle** | `onInstall` / `onUninstall` hooks | Idempotency flags, retry safety, dual-write to platform state |
| **Routing** | Route handlers as functions | `__platform/setup`, `__platform/teardown`, `health`, dispatch routing, 404s |
| **Comms contract** | Declare `capabilities` | Compile-time route enforcement per capability (SMS, voice, numbers, messaging profile, alphanumeric sender, registration) |
| **Search contract** | A `search` handler that maps your provider's fields | Request checks, the response shape and the error codes of `POST /search` |
| **Health** | Optional vendor reachability check | Auto-generated health response, 15s TTL cache, in-flight dedup |
| **Platform auth** | Nothing | Verifies the platform signature on lifecycle and plain routes; refuses them without `BAGDOCK_PLATFORM_SECRET` |
| **Webhooks** | Adapter-local `VerifyFunction` | Clone-based body handoff, structured 401/500 error responses |
| **Errors** | Nothing | Structured JSON errors with timing headers, global error boundary |

## Platform authentication

Every route the platform calls is signed: `__platform/setup`, `__platform/teardown`, and every route declared as a plain handler. The platform sends

```
X-Bagdock-Platform-Timestamp: <unix seconds>
X-Bagdock-Platform-Signature: sha256=<hex HMAC-SHA256>
```

over `${timestamp}.${method}.${origin}${path}.${rawBody}`, keyed with the worker's own derived key, which the platform installs as the `BAGDOCK_PLATFORM_SECRET` secret at deploy. The SDK verifies it before a handler runs:

| Request | Response |
| -- | -- |
| Valid signature within 5 minutes | Handler runs with the body unread |
| Missing, malformed, stale or wrong signature | 401 `Platform authentication failed` |
| Worker has no `BAGDOCK_PLATFORM_SECRET` | 401, reason `unconfigured` |

A plain route builds its context from the dispatch headers, and the installation id there selects whose stored credentials the handler uses, so these routes never run unsigned. Routes that declare `verify` are vendor webhooks and use only their own verifier. `health` stays open.

## Install inputs (`ctx.inputs`)

An adapter can declare operator-supplied install inputs in `bagdock.json`, e.g. a
bring-your-own-API-key field:

```json
"inputs": [
  { "key": "telnyx_api_key", "label": "Telnyx API Key", "type": "password", "required": false,
    "help": "Bring your own Telnyx account. Leave blank to use the managed integration." }
]
```

The operator submits values in the dashboard Connect step. The **platform** resolves
them per-request — reading `text` values from installation config and **unsealing**
`password` values server-side — and delivers the merged plaintext map. Read it from
`ctx.inputs` (keys match `inputs[].key`):

```ts
async function handleSmsSend(ctx: HandlerContext<Env>): Promise<Response> {
  // BYOK: prefer the operator's own key when present; else the managed key.
  const apiKey = ctx.inputs.telnyx_api_key || ctx.env.TELNYX_API_KEY
  // ...
}
```

`ctx.inputs` is `{}` when the adapter declares no inputs or none are set. It may
carry unsealed secrets — treat as sensitive and never persist it. Sealing/unsealing
stays entirely server-side; the SDK performs no crypto.

## Search contract

A search worker answers one platform route, `POST /search`. The platform calls it with the operator's own provider key in `ctx.inputs`. The worker never calls the platform back, so it holds no scope.

```
POST /search
```

| Field | Type | Description |
|-------|------|-------------|
| `query` | string | What to search for, up to 400 characters |
| `since` | date | Earliest publication date wanted, `YYYY-MM-DD` |
| `limit` | integer | Most results wanted, 1 to 10 |

```json
{
  "results": [
    {
      "title": "New storage facility opens in Didsbury",
      "url": "https://didsburypost.example/storage-opens",
      "published_at": "2026-10-20",
      "passage": "The 380-unit site opened on Monday."
    }
  ]
}
```

| Status | Code | Cause |
|--------|------|-------|
| 400 | `invalid_query` | The query is empty or too long, or `since` or `limit` is not as specified. `param` names the field |
| 401 | `provider_key_rejected` | The provider refused the operator's key |
| 429 | `provider_rate_limited` | The provider's limit was reached |
| 502 | `provider_unavailable` | The provider failed or timed out |

An error body is `{ "error": { "type", "code", "message", "param" } }`.

Your handler receives the checked request and returns the provider's hits. The factory builds the response:

```typescript
import { createSearchWorker, SearchProviderError } from '@bagdock/worker-sdk'

export default createSearchWorker<Env>({
  version: '0.1.0',
  capabilities: ['web_search'],
  routes: {
    async search(ctx, { query, since, limit }) {
      const res = await callYourProvider(ctx.inputs.api_key, { query, since, limit })
      if (res.status === 401) throw new SearchProviderError('provider_key_rejected')
      if (res.status === 429) throw new SearchProviderError('provider_rate_limited')
      if (!res.ok) throw new SearchProviderError('provider_unavailable')
      const { items } = (await res.json()) as { items: ProviderItem[] }
      return items.map((item) => ({
        title: item.title,
        url: item.link,
        published_at: item.date,
        passage: item.snippet,
      }))
    },
  },
})
```

What the factory does with the hits:

- `published_at` accepts an ISO 8601 date or date-time, or a dated string that states its zone such as `Tue, 20 Oct 2026 08:30:00 GMT`. It is returned as a UTC `YYYY-MM-DD`. A hit with no date, or one in another form, is returned with `published_at: null`.
- A hit with no http or https `url`, or no `passage`, is left out.
- A dated hit older than `since` is left out. A hit with no date is kept.
- At most `limit` results are returned.
- Anything else the handler throws is reported as `provider_unavailable`. The thrown message goes to the worker's logs and never into the response.

## Webhook verification

The SDK is **vendor-agnostic** — it knows nothing about Telnyx, Stripe, Shopify, or any other vendor. Webhook verification follows the same pattern every major platform uses: the vendor who signs the webhook publishes the SDK that verifies it.

### Default path: vendor SDK (recommended)

```typescript
// src/verify.ts — adapter-local, wraps the vendor's own SDK
import Telnyx from 'telnyx'
import type { VerifyFunction } from '@bagdock/worker-sdk'
import type { Env } from './types'

const client = new Telnyx()

export const telnyxWebhookVerify: VerifyFunction<Env> = async (request, env, body) => {
  try {
    await client.webhooks.unwrap(body, {
      headers: {
        'telnyx-signature-ed25519': request.headers.get('telnyx-signature-ed25519') ?? '',
        'telnyx-timestamp': request.headers.get('telnyx-timestamp') ?? '',
      },
      key: env.TELNYX_WEBHOOK_PUBLIC_KEY,
    })
    return true
  } catch {
    return Response.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }
}
```

### Fallback path: SDK primitives

For vendors without a Workers-compatible SDK, wrap the SDK's crypto primitives:

```typescript
import { ed25519Verify } from '@bagdock/worker-sdk'
import type { VerifyFunction } from '@bagdock/worker-sdk'
import type { Env } from './types'

export const vendorVerify: VerifyFunction<Env> = (req, env, body) =>
  ed25519Verify({
    signature: req.headers.get('x-sig-ed25519'),
    publicKey: env.VENDOR_PUBLIC_KEY,
    signingString: `${req.headers.get('x-timestamp')}|${body}`,
    timestamp: req.headers.get('x-timestamp'),
  })
```

Both `hmacSha256Verify` and `ed25519Verify` handle null signatures, timestamp skew, and constant-time comparison, so callers can pass `headers.get(...)` without pre-checking. A missing timestamp fails verification with a 401. Set `requireTimestamp: false` only for a vendor that signs without a timestamp; a timestamp that is present is still checked against `toleranceMs` (default 5 minutes). Include the timestamp in the signed string, or a replayed request can carry a fresh timestamp header.

## API reference

### Factories

| Export | Description |
|--------|-------------|
| `createBagdockWorker(config)` | Base factory — lifecycle hooks, health, routing, error boundaries |
| `createCommsWorker(config)` | Comms factory — extends base with capabilities-driven typed route enforcement |
| `createSearchWorker(config)` | Search factory: serves `POST /search` and owns its request checks, response shape and error codes |

### Verification primitives

| Export | Description |
|--------|-------------|
| `hmacSha256Verify(opts)` | HMAC-SHA256 verification with constant-time comparison |
| `ed25519Verify(opts)` | Ed25519 verification via Web Crypto |

### Types

| Type | Description |
|------|-------------|
| `HandlerContext<E>` | Unified context for all handlers — operator ID, installation ID, env, store, inputs, logger |
| `VerifyFunction<E>` | Webhook verification contract — `(request, env, rawBody) => Promise<true \| Response>` |
| `CommsCapability` | `'sms' \| 'voice' \| 'numbers' \| 'messaging_profile' \| 'alphanumeric_sender' \| 'registration'` |
| `InstallStore` | Per-installation encrypted state bag (KV-backed) |
| `RouteHandler<E>` | `(ctx: HandlerContext<E>) => Promise<Response>` |
| `SendSMSParams` / `SendSMSResult` | SMS contract types |
| `CreateCallParams` / `CallResult` | Voice contract types |
| `NumberSearchParams` / `AvailableNumber` | Number search: filters, features, quoted prices and requirements |
| `OrderNumberParams` / `OrderNumberResult` | Order one exact number |
| `MessagingProfileParams` / `AlphanumericSenderParams` | Messaging profile and alphanumeric sender |
| `RegistrationSubmitParams` / `RegistrationResult` / `NormalizedRegistrationEvent` | US 10DLC brand, campaign and vetting |
| `SearchCapability` | `'web_search'` |
| `SearchHandler<E>` | `(ctx, request: SearchRequest) => Promise<SearchHit[]>` |
| `SearchRequest` / `SearchHit` / `SearchResult` / `SearchResponse` | Search contract types |
| `SearchProviderError` | Thrown by a search handler with `provider_key_rejected`, `provider_rate_limited` or `provider_unavailable` |

## Documentation

- [Full documentation](https://bagdock.com/docs)
- [Worker SDK guide](https://bagdock.com/docs/workers)
- [API reference](https://bagdock.com/docs/api)

## License

MIT — see [LICENSE](LICENSE)
