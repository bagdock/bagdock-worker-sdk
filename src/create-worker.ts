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
  RouteEntry,
  VerifiedRouteConfig,
} from './types'
import { createContext } from './context'

const START_TIME = Date.now()

let healthCache: { result: { status: 'healthy' | 'degraded' | 'down'; reason?: string }; expiresAt: number } | null = null
let healthInflight: Promise<{ status: 'healthy' | 'degraded' | 'down'; reason?: string }> | null = null
const HEALTH_CACHE_TTL_MS = 15_000

function isVerifiedRoute<E extends BaseEnv>(
  entry: RouteEntry<E>,
): entry is VerifiedRouteConfig<E> {
  return typeof entry === 'object' && 'handler' in entry && 'verify' in entry
}

interface SetupOptions {
  capabilities?: readonly string[]
}

async function handleSetup<E extends BaseEnv>(
  ctx: HandlerContext<E>,
  onInstall: BagdockWorkerConfig<E>['onInstall'],
  opts?: SetupOptions,
): Promise<Response> {
  if (!onInstall) {
    return Response.json({ installation_state: {} })
  }

  const completed = await ctx.store.get('__install_completed')
  if (completed) {
    const stateJson = await ctx.store.get('__install_state')
    return Response.json({
      installation_state: stateJson ? JSON.parse(stateJson) : {},
      ...(opts?.capabilities ? { capabilities: opts.capabilities } : {}),
    })
  }

  const result = await onInstall(ctx)

  if (result?.installation_state) {
    await ctx.store.put(
      '__install_state',
      JSON.stringify(result.installation_state),
    )
  }
  await ctx.store.put('__install_completed', new Date().toISOString())

  return Response.json({
    ...(result ?? { installation_state: {} }),
    ...(opts?.capabilities ? { capabilities: opts.capabilities } : {}),
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
  await ctx.store.put('__uninstall_completed', new Date().toISOString())

  await ctx.store.delete('__install_completed')
  await ctx.store.delete('__install_state')

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

export function createBagdockWorker<E extends BaseEnv>(
  config: BagdockWorkerConfig<E>,
): ExportedHandler<E> {
  return {
    async fetch(request: Request, env: E): Promise<Response> {
      const startMs = Date.now()
      const url = new URL(request.url)
      const path = url.pathname.replace(/^\/+/, '')

      try {
        if (path === '__platform/setup' && request.method === 'POST') {
          const body = (await request.json()) as {
            operator_id: string
            installation_id: string
            environment: string
          }
          const ctx = createContext(request, env, {
            operatorId: body.operator_id,
            installationId: body.installation_id,
            environment: body.environment as 'live' | 'test',
          })
          if (!ctx)
            return Response.json({ error: 'Missing context' }, { status: 400 })
          return await handleSetup(ctx, config.onInstall)
        }

        if (path === '__platform/teardown' && request.method === 'POST') {
          const body = (await request.json()) as {
            operator_id: string
            installation_id: string
          }
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

        const ctx = createContext(request, env)
        if (!ctx) {
          return Response.json(
            { error: 'Missing dispatch headers' },
            { status: 400 },
          )
        }

        if (isVerifiedRoute(route)) {
          const clone = request.clone()
          const rawBody = await request.text()

          const result = await route.verify(clone, env, rawBody)
          if (result !== true) return result

          const verifiedCtx: HandlerContext<E> = { ...ctx, request: clone }
          return await route.handler(verifiedCtx)
        }

        return await route(ctx)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Internal error'
        console.error(`[worker-sdk] ${path} error:`, err)
        return Response.json(
          { error: message, path },
          {
            status: 500,
            headers: { 'X-Response-Time-Ms': String(Date.now() - startMs) },
          },
        )
      }
    },
  }
}

export { handleSetup, handleTeardown, handleHealth }
