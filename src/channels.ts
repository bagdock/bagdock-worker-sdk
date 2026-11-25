/**
 * Route builders for the three installation channels (BDOK-3195).
 *
 * ```ts
 * createBagdockWorker({
 *   routes: {
 *     'bagdock/events': bagdockEventsRoute({
 *       'valet_order.confirmed': async (event, ctx) => { ... },
 *     }),
 *     'bagdock/tick': tickRoute(async (tick, ctx) => { ... }),
 *     'webhooks/onfleet': installationWebhookRoute({
 *       verify: async (ctx) => checkOnfleetSignature(ctx.rawBody, ctx.request, ctx.inputs.webhook_secret),
 *       handler: async (ctx) => { ... },
 *     }),
 *   },
 * })
 * ```
 *
 * The manifest declares the matching routes: `events` and `eventsRoute`
 * (default `bagdock/events`), `tick` (default route `bagdock/tick`) and
 * `webhooks[].path`. The events and tick routes are plain routes, so they run
 * only on a call the platform signed; an installation webhook route also
 * requires the platform's signature, which the per-installation URL adds.
 */

import type {
  BagdockEventDelivery,
  BagdockEventHandler,
  BaseEnv,
  HandlerContext,
  InstallationWebhookRouteConfig,
  RouteHandler,
  TickDelivery,
  TickHandler,
} from './types'

async function readJson(ctx: HandlerContext): Promise<unknown> {
  try {
    return await ctx.request.json()
  } catch {
    return undefined
  }
}

function isEventDelivery(body: unknown): body is BagdockEventDelivery {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return typeof b.event_id === 'string' && typeof b.event_type === 'string' &&
    typeof b.occurred_at === 'string' && !!b.data && typeof b.data === 'object'
}

/**
 * The route the platform delivers the manifest's declared `events` to. Each
 * event goes to the handler for its type. A type with no handler answers 200
 * with `handled: false`, so the platform does not retry it.
 */
export function bagdockEventsRoute<E extends BaseEnv = BaseEnv>(
  handlers: Partial<Record<string, BagdockEventHandler<E>>>,
): RouteHandler<E> {
  return async (ctx) => {
    const body = await readJson(ctx as HandlerContext)
    if (!isEventDelivery(body)) {
      return Response.json({ error: 'Invalid event body' }, { status: 400 })
    }
    const handler = handlers[body.event_type]
    if (!handler) return Response.json({ received: true, handled: false })
    const result = await handler(body, ctx)
    return result instanceof Response ? result : Response.json({ received: true, handled: true })
  }
}

/** The route the platform calls on the manifest's `tick` interval. */
export function tickRoute<E extends BaseEnv = BaseEnv>(handler: TickHandler<E>): RouteHandler<E> {
  return async (ctx) => {
    const body = await readJson(ctx as HandlerContext) as Partial<TickDelivery> | undefined
    if (!body || body.object !== 'tick' || typeof body.id !== 'string' ||
        typeof body.scheduled_at !== 'string' || typeof body.interval_seconds !== 'number') {
      return Response.json({ error: 'Invalid tick body' }, { status: 400 })
    }
    const result = await handler(body as TickDelivery, ctx)
    return result instanceof Response ? result : Response.json({ ok: true })
  }
}

/**
 * A vendor webhook that arrives through the platform's per-installation URL,
 * with the installation's context. See `InstallationWebhookRouteConfig`.
 */
export function installationWebhookRoute<E extends BaseEnv = BaseEnv>(
  config: Omit<InstallationWebhookRouteConfig<E>, 'kind'>,
): InstallationWebhookRouteConfig<E> {
  return { kind: 'installation_webhook', ...config }
}
