/**
 * Platform signature on plain and lifecycle routes (BDOK-1701).
 *
 * A plain route builds its context from the dispatch headers, and the
 * installation id there picks whose stored vendor credentials the handler uses.
 * These tests drive each worker factory end to end: an unsigned call with valid
 * dispatch headers is refused, a signed one reaches the handler with its body
 * intact, and a worker without `BAGDOCK_PLATFORM_SECRET` refuses lifecycle and
 * plain routes alike. Vendor webhook routes keep their own verifier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBagdockWorker, PLATFORM_SECRET_BINDING } from '../create-worker'
import { createCommsWorker } from '../create-comms-worker'
import { createPaymentsWorker } from '../create-payments-worker'
import { computePlatformSignature, PLATFORM_AUTH_HEADERS } from '../platform-auth'
import type { BaseEnv, HandlerContext, RouteEntry } from '../types'

const KEY = 'worker_derived_key_fixture'
const ORIGIN = 'https://bagdock-telnyx-pre.bdok.dev'

const DISPATCH = {
  'x-bagdock-operator-id': 'opreg_victim',
  'x-bagdock-installation-id': 'ainst_victim',
  'x-bagdock-environment': 'live',
}

const SMS_BODY = JSON.stringify({ to: '+447700900000', body: 'hello' })

async function signedHeaders(
  method: string,
  url: string,
  body: string,
  key: string = KEY,
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000)
  return {
    [PLATFORM_AUTH_HEADERS.timestamp]: String(ts),
    [PLATFORM_AUTH_HEADERS.signature]: `sha256=${await computePlatformSignature(key, ts, method, url, body)}`,
  }
}

async function call(
  worker: ExportedHandler<BaseEnv>,
  env: BaseEnv,
  route: string,
  opts: { body?: string; signWith?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = `${ORIGIN}/${route}`
  const body = opts.body ?? SMS_BODY
  const signature = opts.signWith === null ? {} : await signedHeaders('POST', url, body, opts.signWith ?? KEY)
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...DISPATCH, ...signature, ...opts.headers },
    body,
  })
  return worker.fetch!(req as any, env as any, {} as any) as Promise<Response>
}

const sent: Array<{ installationId: string; body: unknown }> = []
const smsSend = vi.fn(async (ctx: HandlerContext<BaseEnv>) => {
  sent.push({ installationId: ctx.installationId, body: await ctx.request.json() })
  return Response.json({ id: 'msg_1', status: 'queued' })
})
const webhook = {
  handler: vi.fn(async () => Response.json({ received: true })),
  verify: vi.fn(async () => true as const),
}
const onInstall = vi.fn(async () => ({ installation_state: {} }))
const onUninstall = vi.fn(async () => ({ ok: true }))

const routes: Record<string, RouteEntry<BaseEnv>> = { 'sms/send': smsSend, 'webhooks/sms': webhook }

const FACTORIES: Array<[string, () => ExportedHandler<BaseEnv>]> = [
  ['createBagdockWorker', () => createBagdockWorker({ routes, onInstall, onUninstall })],
  ['createCommsWorker', () => createCommsWorker({ capabilities: ['sms'], routes: routes as any, onInstall, onUninstall })],
  ['createPaymentsWorker', () => createPaymentsWorker({ capabilities: ['charges'], routes: routes as any, onInstall, onUninstall })],
]

const configured: BaseEnv = { [PLATFORM_SECRET_BINDING]: KEY }
const unconfigured: BaseEnv = {}

beforeEach(() => {
  sent.length = 0
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe.each(FACTORIES)('%s', (_name, make) => {
  it('refuses an unsigned plain route with valid dispatch headers', async () => {
    const res = await call(make(), configured, 'sms/send', { signWith: null })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Platform authentication failed', reason: 'missing_signature' })
    expect(smsSend).not.toHaveBeenCalled()
  })

  it('refuses a plain route signed with another worker\'s key', async () => {
    const res = await call(make(), configured, 'sms/send', { signWith: 'some_other_workers_key' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).reason).toBe('bad_signature')
    expect(smsSend).not.toHaveBeenCalled()
  })

  it('refuses a signed body with the body swapped', async () => {
    const url = `${ORIGIN}/sms/send`
    const req = new Request(url, {
      method: 'POST',
      headers: { ...DISPATCH, ...(await signedHeaders('POST', url, SMS_BODY)) },
      body: JSON.stringify({ to: '+15550000000', body: 'attacker text' }),
    })
    const res = await make().fetch!(req as any, configured as any, {} as any)
    expect(res.status).toBe(401)
    expect(smsSend).not.toHaveBeenCalled()
  })

  it('runs a signed plain route with the body readable and the dispatch context', async () => {
    const res = await call(make(), configured, 'sms/send')
    expect(res.status).toBe(200)
    expect(sent).toEqual([{ installationId: 'ainst_victim', body: JSON.parse(SMS_BODY) }])
  })

  it('answers 400 to a signed call without dispatch headers', async () => {
    const res = await call(make(), configured, 'sms/send', {
      headers: { 'x-bagdock-installation-id': '' },
    })
    expect(res.status).toBe(400)
    expect(smsSend).not.toHaveBeenCalled()
  })

  it('refuses a plain route when the worker has no platform secret, even if signed', async () => {
    const res = await call(make(), unconfigured, 'sms/send')
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).reason).toBe('unconfigured')
    expect(smsSend).not.toHaveBeenCalled()
  })

  it.each(['__platform/setup', '__platform/teardown'])(
    'refuses %s when the worker has no platform secret',
    async (route) => {
      const body = JSON.stringify({ operator_id: 'opreg_victim', installation_id: 'ainst_victim', environment: 'live' })
      const res = await call(make(), unconfigured, route, { body, signWith: null })
      expect(res.status).toBe(401)
      expect(((await res.json()) as any).reason).toBe('unconfigured')
      expect(onInstall).not.toHaveBeenCalled()
      expect(onUninstall).not.toHaveBeenCalled()
    },
  )

  it('runs a signed lifecycle call when the secret is set', async () => {
    const body = JSON.stringify({ operator_id: 'opreg_1', installation_id: 'ainst_1', environment: 'test' })
    const res = await call(make(), configured, '__platform/setup', { body })
    expect(res.status).toBe(200)
    expect(onInstall).toHaveBeenCalledOnce()
  })

  it('leaves vendor webhook routes to their own verifier', async () => {
    const res = await call(make(), configured, 'webhooks/sms', { signWith: null })
    expect(res.status).toBe(200)
    expect(webhook.verify).toHaveBeenCalledOnce()
    expect(webhook.handler).toHaveBeenCalledOnce()
  })

  it('keeps health open for probes', async () => {
    const res = await make().fetch!(new Request(`${ORIGIN}/health`) as any, unconfigured as any, {} as any)
    expect(res.status).toBe(200)
  })
})
