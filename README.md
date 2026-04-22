# @bagdock/worker-sdk

Platform SDK for building [Bagdock](https://bagdock.com) adapter workers on Cloudflare Workers.

## What it does

- **Lifecycle hooks** — `onInstall` / `onUninstall` with idempotency, retry safety, and dual-write to platform state
- **Typed comms contract** — `createCommsWorker` enforces routes per declared capabilities (SMS, voice, numbers)
- **Health checks** — Auto-generated health endpoint with optional vendor reachability hooks (cached, deduped)
- **Webhook verification primitives** — `hmacSha256Verify`, `ed25519Verify` for vendors without a Workers-compatible SDK
- **Error boundaries** — Structured JSON errors with timing headers

## Install

```bash
npm install @bagdock/worker-sdk
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
    // Provision vendor resources, store secrets
    return { installation_state: { sub_account_id: '...' } }
  },

  async onUninstall(ctx) {
    // Clean up vendor resources
  },

  routes: {
    'sms/send': handleSmsSend,
    'numbers/search': handleNumbersSearch,
    'numbers/provision': handleNumbersProvision,
    'webhooks/sms': { handler: handleSmsWebhook, verify: telnyxWebhookVerify },
  },
})
```

## Webhook verification

The SDK is vendor-agnostic. Use your vendor's SDK for verification (recommended), or wrap the SDK's primitives for vendors without Workers-compatible SDKs:

```typescript
import { ed25519Verify } from '@bagdock/worker-sdk'
import type { VerifyFunction } from '@bagdock/worker-sdk'
import type { Env } from './types'

export const myVerify: VerifyFunction<Env> = (req, env, body) =>
  ed25519Verify({
    signature: req.headers.get('x-sig-ed25519'),
    publicKey: env.VENDOR_PUBLIC_KEY,
    signingString: `${req.headers.get('x-timestamp')}|${body}`,
  })
```

## License

MIT
