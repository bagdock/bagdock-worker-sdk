/**
 * createBagdockWorker — Base factory for Bagdock platform workers.
 *
 * Handles __platform/setup, __platform/teardown, health, routing, error
 * boundaries, and webhook verification. Developer writes lifecycle hooks
 * and route handlers; the SDK does the rest.
 */

import type {
  BaseEnv,
  BagdockWorkerConfig,
  HandlerContext,
  HealthResponse,
  InstallationWebhookRouteConfig,
  RouteEntry,
  VerifiedRouteConfig,
} from './types'
import { createContext } from './context'
import { isPreparedCredential } from './credentials'
import { verifyPlatformRequest, platformAuthError } from './platform-auth'

const START_TIME = Date.now()

/**
 * Worker secret holding this worker's platform signing key, derived by the
 * operator API from its `ADAPTER_PLATFORM_DISPATCH_SECRET` and installed at
 * deploy. Absent, the lifecycle routes and every plain route answer 401
 * `unconfigured` (BDOK-1277, BDOK-1701).
 */
export const PLATFORM_SECRET_BINDING = 'BAGDOCK_PLATFORM_SECRET'

let healthCache: { result: { status: 'healthy' | 'degraded' | 'down'; reason?: string }; expiresAt: number } | null = null
let healthInflight: Promise<{ status: 'healthy' | 'degraded' | 'down'; reason?: string }> | null = null
const HEALTH_CACHE_TTL_MS = 15_000

function isInstallationWebhookRoute<E extends BaseEnv>(
  entry: RouteEntry<E>,
): entry is InstallationWebhookRouteConfig<E> {
  return typeof entry === 'object' && (entry as { kind?: unknown }).kind === 'installation_webhook'
}

function isVerifiedRoute<E extends BaseEnv>(
  entry: RouteEntry<E>,
): entry is VerifiedRouteConfig<E> {
  return typeof entry === 'object' && !isInstallationWebhookRoute(entry) &&
    'handler' in entry && 'verify' in entry
}

/**
 * Read the body and verify the platform's signature over it. Returns the raw
 * body, or the 401 to send. Lifecycle and plain routes share it, so the two
 * cannot drift apart on the same trust boundary.
 */
async function authenticatePlatformCall(
  request: Request,
  env: BaseEnv,
  route: string,
): Promise<string | Response> {
  const rawBody = await request.text()
  const auth = await verifyPlatformRequest(
    request,
    env[PLATFORM_SECRET_BINDING] as string | undefined,
    rawBody,
  )
  if (!auth.ok) {
    console.warn(`[platform-auth] rejected ${route}: ${auth.reason}`)
    return platformAuthError(auth.reason)
  }
  return rawBody
}

/**
 * Read, authenticate and parse a `__platform/*` lifecycle body (BDOK-1277).
 *
 * These two routes act on the `operator_id` and `installation_id` in their
 * body, so the body has to be attributable to the platform before a hook runs.
 * The raw text is read once and handed to the verifier, because the signature
 * covers the exact bytes sent — re-serialising the parsed object would change
 * key order and spacing and never match.
 *
 * When `BAGDOCK_PLATFORM_SECRET` is not set on the worker the call is refused
 * with 401 `unconfigured`. Accepting it, as before 0.6.0, left teardown open to
 * any caller on an adapter deployed without its secret (BDOK-1701).
 */
export async function readLifecycleBody<T>(
  request: Request,
  env: BaseEnv,
  route: string,
): Promise<T | Response> {
  const rawBody = await authenticatePlatformCall(request, env, route)
  if (rawBody instanceof Response) return rawBody

  try {
    return JSON.parse(rawBody) as T
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
}

/**
 * Run a non-lifecycle route: the shared tail of every worker factory.
 *
 * A route that declares `verify` is a vendor webhook; its own verifier
 * authenticates it. Every other route is a platform call, and its context comes
 * from the dispatch headers, whose installation id picks whose stored vendor
 * credentials the handler uses. So a plain route runs only when the platform's
 * signature over the exact body verifies against `BAGDOCK_PLATFORM_SECRET`
 * (BDOK-1701). Authentication comes before the header check, so an
 * unauthenticated caller learns nothing about the context a route expects.
 *
 * The handler receives a clone with the body unread, as verified routes do.
 */
export async function dispatchRoute<E extends BaseEnv>(
  route: RouteEntry<E>,
  request: Request,
  env: E,
  path: string,
): Promise<Response> {
  // A vendor webhook forwarded by the platform's per-installation URL
  // (BDOK-3195). The platform's signature comes first: it is what makes the
  // dispatch headers, and so the install inputs the vendor check uses,
  // attributable to the platform. A direct vendor delivery has no signature
  // and is refused.
  if (isInstallationWebhookRoute(route)) {
    const clone = request.clone()
    const rawBody = await authenticatePlatformCall(request, env, path)
    if (rawBody instanceof Response) return rawBody

    const ctx = createContext(clone, env)
    if (!ctx) {
      return Response.json(
        { error: 'Missing dispatch headers' },
        { status: 400 },
      )
    }
    const webhookCtx = { ...ctx, request: clone, rawBody }
    if (route.verify) {
      const verified = await route.verify(webhookCtx)
      if (verified !== true) return verified
    }
    return await route.handler(webhookCtx)
  }

  if (isVerifiedRoute(route)) {
    const clone = request.clone()
    const rawBody = await request.text()

    // The vendor signature is checked first: a direct vendor delivery carries
    // no dispatch headers, so reading them first answered 400 before the
    // verifier ran (BDOK-568).
    const result = await route.verify(clone, env, rawBody)
    if (result !== true) return result

    const ctx = createContext(clone, env, { accountLevel: true })
    if (!ctx) {
      return Response.json(
        { error: 'Missing dispatch headers' },
        { status: 400 },
      )
    }
    return await route.handler({ ...ctx, request: clone })
  }

  const clone = request.clone()
  const auth = await authenticatePlatformCall(request, env, path)
  if (auth instanceof Response) return auth

  const ctx = createContext(clone, env)
  if (!ctx) {
    return Response.json(
      { error: 'Missing dispatch headers' },
      { status: 400 },
    )
  }
  return await route(ctx)
}

interface SetupOptions {
  capabilities?: readonly string[]
}

async function handleSetup<E extends BaseEnv>(
  ctx: HandlerContext<E>,
  onInstall: BagdockWorkerConfig<E>['onInstall'],
  opts?: SetupOptions,
): Promise<Response> {
  const capabilities = opts?.capabilities ? { capabilities: opts.capabilities } : {}

  if (!onInstall) {
    return Response.json({
      installation_state: {},
      ...capabilities,
    })
  }

  const completed = await ctx.store.get('__install_completed')
  if (completed) {
    const stateJson = await ctx.store.get('__install_state')
    // Replay connected_account too — a retry-setup after a control-plane-side
    // persistence failure must still receive the (encrypted) credential copy.
    const connectedJson = await ctx.store.get('__install_connected_account')
    return Response.json({
      installation_state: stateJson ? JSON.parse(stateJson) : {},
      ...(connectedJson ? { connected_account: JSON.parse(connectedJson) } : {}),
      ...capabilities,
    })
  }

  const result = await onInstall(ctx)

  // Runtime backstop for the credential-carrying contract (BDOK-557 scope 4): a
  // credential-bearing install must hand over a PreparedCredential (built by
  // ctx.credentials.store) so the platform can seal it on ingest. An `as`-cast
  // that put a bare secret on `credential` throws here, never reaching the
  // control plane as an unmanaged value.
  if (result?.connected_account && 'credential' in result.connected_account) {
    if (!isPreparedCredential(result.connected_account.credential)) {
      throw new Error(
        'connected_account.credential must come from ctx.credentials.store() — ' +
          'raw secrets are sealed by the platform, not the worker',
      )
    }
  }

  if (result?.installation_state) {
    await ctx.store.put(
      '__install_state',
      JSON.stringify(result.installation_state),
    )
  }
  if (result?.connected_account) {
    await ctx.store.put(
      '__install_connected_account',
      JSON.stringify(result.connected_account),
    )
  }
  await ctx.store.put('__install_completed', new Date().toISOString())

  return Response.json({
    ...(result ?? { installation_state: {} }),
    ...capabilities,
  })
}

async function handleTeardown<E extends BaseEnv>(
  ctx: HandlerContext<E>,
  onUninstall: BagdockWorkerConfig<E>['onUninstall'],
): Promise<Response> {
  if (!onUninstall) {
    return Response.json({ ok: true })
  }

  const completed = await ctx.store.get('__uninstall_completed')
  if (completed) {
    return Response.json({ ok: true, already_completed: true })
  }

  await ctx.store.put('__uninstall_started', new Date().toISOString())
  const result = await onUninstall(ctx)

  await ctx.store.delete('__install_completed')
  await ctx.store.delete('__install_state')
  await ctx.store.delete('__install_connected_account')

  // Completed flag goes LAST: if any cleanup delete above fails, the retry
  // must not short-circuit on the flag and skip cleanup forever. onUninstall
  // hooks are store-guarded, so a re-run after partial cleanup is safe.
  await ctx.store.put('__uninstall_completed', new Date().toISOString())

  return Response.json(result ?? { ok: true })
}

async function handleHealth<E extends BaseEnv>(
  config: BagdockWorkerConfig<E>,
  env: E,
  ctx: HandlerContext<E> | null,
): Promise<Response> {
  const base: HealthResponse = {
    status: 'healthy',
    version: config.version ?? '0.0.0',
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    adapter: (env.ADAPTER_NAME as string) ?? 'unknown',
  }

  if (config.healthCheck && ctx) {
    const now = Date.now()
    let hookResult: { status: 'healthy' | 'degraded' | 'down'; reason?: string }

    if (healthCache && now < healthCache.expiresAt) {
      hookResult = healthCache.result
    } else if (healthInflight) {
      hookResult = await healthInflight
    } else {
      const promise = config.healthCheck(ctx)
      healthInflight = promise
      try {
        hookResult = await promise
        healthCache = { result: hookResult, expiresAt: now + HEALTH_CACHE_TTL_MS }
      } finally {
        healthInflight = null
      }
    }

    base.status = hookResult.status
    if (hookResult.reason) base.reason = hookResult.reason
  }

  return Response.json(base)
}

/**
 * The fetch handler every factory serves: lifecycle, health, then the route
 * table through `dispatchRoute`. `capabilities`, when given, are reported in
 * the `__platform/setup` response. `createCommsWorker` and
 * `createPaymentsWorker` predate this and carry their own copy.
 */
export function buildWorker<E extends BaseEnv>(
  config: BagdockWorkerConfig<E>,
  opts: SetupOptions & { logTag: string },
): ExportedHandler<E> {
  return {
    async fetch(request: Request, env: E): Promise<Response> {
      const startMs = Date.now()
      const url = new URL(request.url)
      const path = url.pathname.replace(/^\/+/, '')

      try {
        if (path === '__platform/setup' && request.method === 'POST') {
          const body = await readLifecycleBody<{
            operator_id: string
            installation_id: string
            environment: string
            input_values?: Record<string, string>
          }>(request, env, '__platform/setup')
          if (body instanceof Response) return body
          const ctx = createContext(request, env, {
            operatorId: body.operator_id,
            installationId: body.installation_id,
            environment: body.environment as 'live' | 'test',
            // Setup has no dispatch header; install inputs (if any) arrive in the
            // body (BDOK-560 sends `input_values`). Exposed on `ctx.inputs`.
            inputs: body.input_values ?? {},
          })
          if (!ctx)
            return Response.json({ error: 'Missing context' }, { status: 400 })
          return await handleSetup(ctx, config.onInstall, opts)
        }

        if (path === '__platform/teardown' && request.method === 'POST') {
          const body = await readLifecycleBody<{
            operator_id: string
            installation_id: string
          }>(request, env, '__platform/teardown')
          if (body instanceof Response) return body
          const ctx = createContext(request, env, {
            operatorId: body.operator_id,
            installationId: body.installation_id,
            environment: 'live',
          })
          if (!ctx)
            return Response.json({ error: 'Missing context' }, { status: 400 })
          return await handleTeardown(ctx, config.onUninstall)
        }

        if (path === 'health' && request.method === 'GET') {
          const ctx = createContext(request, env)
          return await handleHealth(config, env, ctx)
        }

        const route = config.routes[path]
        if (!route) {
          return Response.json(
            { error: 'Not found', path },
            { status: 404 },
          )
        }

        return await dispatchRoute(route, request, env, path)
      } catch (err: unknown) {
        // Full error stays in logs only — vendor/library messages can carry
        // internal detail (account ids, endpoints) that must not reach callers.
        console.error(`[${opts.logTag}] ${path} error:`, err)
        return Response.json(
          { error: 'Internal error', path },
          {
            status: 500,
            headers: { 'X-Response-Time-Ms': String(Date.now() - startMs) },
          },
        )
      }
    },
  }
}

export function createBagdockWorker<E extends BaseEnv>(
  config: BagdockWorkerConfig<E>,
): ExportedHandler<E> {
  return buildWorker(config, { logTag: 'worker-sdk' })
}

export { handleSetup, handleTeardown, handleHealth }
