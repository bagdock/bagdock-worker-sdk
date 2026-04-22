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
import type { Env } from './types'
import { telnyxWebhookVerify } from './verify'

export default createCommsWorker<Env>({
  capabilities: ['sms', 'numbers'],

  async onInstall(ctx) {
    const sub = await createTelnyxSubAccount(ctx.operatorId, ctx.env.TELNYX_API_KEY)
    await ctx.store.put('sub_account_id', sub.id)
    await ctx.store.put('api_key', sub.api_key)
    return { installation_state: { sub_account_id: sub.id } }
  },

  async onUninstall(ctx) {
    await transferNumbersToParent(ctx)
    await suspendSubAccount(ctx)
  },

  routes: {
    'sms/send': handleSmsSend,
    'numbers/search': handleNumbersSearch,
    'numbers/provision': handleNumbersProvision,
    'webhooks/sms': { handler: handleSmsWebhook, verify: telnyxWebhookVerify },
  },
})
```

## What the SDK handles

| Concern | You write | SDK handles |
|---------|-----------|-------------|
| **Lifecycle** | `onInstall` / `onUninstall` hooks | Idempotency flags, retry safety, dual-write to platform state |
| **Routing** | Route handlers as functions | `__platform/setup`, `__platform/teardown`, `health`, dispatch routing, 404s |
| **Comms contract** | Declare `capabilities` | Compile-time route enforcement per capability (SMS, voice, numbers) |
| **Health** | Optional vendor reachability check | Auto-generated health response, 15s TTL cache, in-flight dedup |
| **Webhooks** | Adapter-local `VerifyFunction` | Clone-based body handoff, structured 401/500 error responses |
| **Errors** | Nothing | Structured JSON errors with timing headers, global error boundary |

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

Both `hmacSha256Verify` and `ed25519Verify` handle null signatures, timestamp skew, and constant-time comparison — callers can safely pass `headers.get(...)` without pre-checking.

## API reference

### Factories

| Export | Description |
|--------|-------------|
| `createBagdockWorker(config)` | Base factory — lifecycle hooks, health, routing, error boundaries |
| `createCommsWorker(config)` | Comms factory — extends base with capabilities-driven typed route enforcement |

### Verification primitives

| Export | Description |
|--------|-------------|
| `hmacSha256Verify(opts)` | HMAC-SHA256 verification with constant-time comparison |
| `ed25519Verify(opts)` | Ed25519 verification via Web Crypto |

### Types

| Type | Description |
|------|-------------|
| `HandlerContext<E>` | Unified context for all handlers — operator ID, installation ID, env, store, logger |
| `VerifyFunction<E>` | Webhook verification contract — `(request, env, rawBody) => Promise<true \| Response>` |
| `CommsCapability` | `'sms' \| 'voice' \| 'numbers'` |
| `InstallStore` | Per-installation encrypted state bag (KV-backed) |
| `RouteHandler<E>` | `(ctx: HandlerContext<E>) => Promise<Response>` |
| `SendSMSParams` / `SendSMSResult` | SMS contract types |
| `CreateCallParams` / `CallResult` | Voice contract types |
| `NumberSearchParams` / `AvailableNumber` | Numbers contract types |

## Documentation

- [Full documentation](https://bagdock.com/docs)
- [Worker SDK guide](https://bagdock.com/docs/workers)
- [API reference](https://bagdock.com/docs/api)

## License

MIT — see [LICENSE](LICENSE)
