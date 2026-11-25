/**
 * Installation channels (BDOK-3195): Bagdock events, the scheduled tick and
 * vendor webhooks forwarded by the platform's per-installation URL.
 */

import { describe, it, expect, vi } from 'vitest'
import { createBagdockWorker, PLATFORM_SECRET_BINDING } from '../create-worker'
import { bagdockEventsRoute, installationWebhookRoute, tickRoute } from '../channels'
import { computePlatformSignature, PLATFORM_AUTH_HEADERS } from '../platform-auth'
import { hmacSha256Verify } from '../verify'
import type { BaseEnv, HandlerContext } from '../types'

const KEY = 'worker_derived_key_fixture'
const ORIGIN = 'https://onfleet-default.bdok.dev'
const env: BaseEnv = { [PLATFORM_SECRET_BINDING]: KEY }

function inputsHeader(inputs: Record<string, string>): string {
  return btoa(JSON.stringify(inputs))
}

const DISPATCH = {
  'x-bagdock-operator-id': 'opreg_1',
  'x-bagdock-installation-id': 'ainst_1',
  'x-bagdock-environment': 'live',
  'x-bagdock-install-inputs': inputsHeader({ webhook_secret: 'vendor_secret', dispatch_mode: 'bagdock' }),
}

async function send(
  worker: ExportedHandler<BaseEnv>,
  path: string,
  opts: { method?: string; body?: string; sign?: boolean; headers?: Record<string, string>; dispatch?: boolean } = {},
): Promise<Response> {
  const method = opts.method ?? 'POST'
  const url = `${ORIGIN}/${path}`
  const body = opts.body ?? ''
  const headers: Record<string, string> = { ...(opts.dispatch === false ? {} : DISPATCH), ...opts.headers }
  if (opts.sign !== false) {
    const ts = Math.floor(Date.now() / 1000)
    headers[PLATFORM_AUTH_HEADERS.timestamp] = String(ts)
    headers[PLATFORM_AUTH_HEADERS.signature] = `sha256=${await computePlatformSignature(KEY, ts, method, url, body)}`
  }
  const req = new Request(url, { method, headers, body: method === 'GET' ? undefined : body })
  return worker.fetch!(req as any, env as any, {} as any) as Promise<Response>
}

describe('bagdockEventsRoute', () => {
  const confirmed = vi.fn(async (_event: unknown, _ctx: HandlerContext) => {})
  const worker = createBagdockWorker({
    routes: { 'bagdock/events': bagdockEventsRoute({ 'valet_order.confirmed': confirmed }) },
  })
  const event = {
    event_id: 'evt_1',
    event_type: 'valet_order.confirmed',
    occurred_at: '2026-11-25T09:00:00.000Z',
    data: { order_id: 'vo_1' },
  }

  it('hands a signed event to its handler with the installation id and inputs', async () => {
    const res = await send(worker, 'bagdock/events', { body: JSON.stringify(event) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, handled: true })
    const [delivered, ctx] = confirmed.mock.calls[0]
    expect(delivered).toEqual(event)
    expect(ctx.installationId).toBe('ainst_1')
    expect(ctx.operatorId).toBe('opreg_1')
    expect(ctx.inputs).toEqual({ webhook_secret: 'vendor_secret', dispatch_mode: 'bagdock' })
  })

  it('answers 200 unhandled for a type with no handler', async () => {
    const res = await send(worker, 'bagdock/events', { body: JSON.stringify({ ...event, event_type: 'valet_order.created' }) })
    expect(await res.json()).toEqual({ received: true, handled: false })
  })

  it('refuses an unsigned delivery', async () => {
    const res = await send(worker, 'bagdock/events', { body: JSON.stringify(event), sign: false })
    expect(res.status).toBe(401)
  })

  it('answers 400 for a body that is not an event', async () => {
    const res = await send(worker, 'bagdock/events', { body: JSON.stringify({ hello: 'world' }) })
    expect(res.status).toBe(400)
  })

  it('answers 500 when the handler throws, so the platform retries', async () => {
    const failing = createBagdockWorker({
      routes: { 'bagdock/events': bagdockEventsRoute({ 'valet_order.confirmed': async () => { throw new Error('provider down') } }) },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(failing, 'bagdock/events', { body: JSON.stringify(event) })
    expect(res.status).toBe(500)
  })
})

describe('tickRoute', () => {
  const onTick = vi.fn(async () => {})
  const worker = createBagdockWorker({ routes: { 'bagdock/tick': tickRoute(onTick) } })
  const tick = { object: 'tick', id: 'tick_ainst_1_29400000', scheduled_at: '2025-11-25T09:00:00.000Z', interval_seconds: 60 }

  it('runs the handler on a signed tick with the installation context', async () => {
    const res = await send(worker, 'bagdock/tick', { body: JSON.stringify(tick) })
    expect(res.status).toBe(200)
    expect(onTick).toHaveBeenCalledWith(tick, expect.objectContaining({ installationId: 'ainst_1' }))
  })

  it('refuses an unsigned tick', async () => {
    const res = await send(worker, 'bagdock/tick', { body: JSON.stringify(tick), sign: false })
    expect(res.status).toBe(401)
  })
})

describe('installationWebhookRoute', () => {
  const vendorBody = JSON.stringify({ triggerId: 3, taskId: 'task_1' })

  async function vendorSignature(body: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  const handler = vi.fn(async (ctx: HandlerContext & { rawBody: string }) =>
    Response.json({ installation: ctx.installationId, body: JSON.parse(ctx.rawBody) }))
  const worker = createBagdockWorker({
    routes: {
      'webhooks/vendor': installationWebhookRoute({
        // The installation's own secret checks the vendor's signature.
        verify: (ctx) => hmacSha256Verify({
          secret: ctx.inputs.webhook_secret,
          signingString: ctx.rawBody,
          signature: ctx.request.headers.get('x-vendor-signature'),
          requireTimestamp: false,
        }),
        handler,
      }),
      'webhooks/check': installationWebhookRoute({
        handler: async (ctx) => new Response(new URL(ctx.request.url).searchParams.get('check') ?? ''),
      }),
    },
  })

  it('runs with the installation context when the vendor signature matches its secret', async () => {
    const res = await send(worker, 'webhooks/vendor', {
      body: vendorBody,
      headers: { 'x-vendor-signature': await vendorSignature(vendorBody, 'vendor_secret') },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ installation: 'ainst_1', body: { triggerId: 3, taskId: 'task_1' } })
  })

  it('refuses a vendor signature made with another secret', async () => {
    const res = await send(worker, 'webhooks/vendor', {
      body: vendorBody,
      headers: { 'x-vendor-signature': await vendorSignature(vendorBody, 'someone_else') },
    })
    expect(res.status).toBe(401)
  })

  it('refuses a direct vendor delivery that the platform did not sign', async () => {
    const res = await send(worker, 'webhooks/vendor', {
      body: vendorBody,
      sign: false,
      headers: { 'x-vendor-signature': await vendorSignature(vendorBody, 'vendor_secret') },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ reason: 'missing_signature' })
  })

  it('answers 400 for a signed forward without dispatch headers', async () => {
    const res = await send(worker, 'webhooks/check', { method: 'GET', dispatch: false })
    expect(res.status).toBe(400)
  })

  it('serves a forwarded GET validation with its query string', async () => {
    const res = await send(worker, 'webhooks/check?check=abc123', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc123')
  })
})
