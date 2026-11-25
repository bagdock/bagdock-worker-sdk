/**
 * Runtime helpers for two controls every Bagdock app meets:
 *
 * - `pickFields`: outbound payloads are built from an explicit field
 *   allowlist, never by forwarding a Bagdock record whole. The allowlist is the
 *   supplier's `fields` in the manifest's `dataTransfer` declaration.
 * - `createReplayGuard`: an inbound vendor webhook that passed its signature
 *   check is accepted once. The signature primitives in `verify.ts` bound a
 *   delivery to a five-minute window; within that window a captured delivery
 *   still verifies, so the worker also refuses an id it has already seen.
 *
 * Both are dependency-free so they bundle into any Worker.
 */

/** A value that is not a plain object or array is copied as is. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Copy only the listed fields of `source` into a new object. A field is a key
 * or a dotted path (`address.postcode`); the nested shape is kept. A listed
 * field the source lacks is left out, never set to `undefined`. Keys named
 * `__proto__`, `constructor` or `prototype` are never copied.
 *
 * ```ts
 * const body = pickFields(contact, supplier.fields) // ['email', 'first_name']
 * await fetch('https://api.example-mail.com/members', { method: 'POST', body: JSON.stringify(body) })
 * ```
 */
export function pickFields(source: unknown, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  if (!isRecord(source)) return out
  for (const field of fields) {
    const parts = field.split('.')
    if (parts.some((p) => !p || p === '__proto__' || p === 'constructor' || p === 'prototype')) continue
    let from: unknown = source
    for (const part of parts) {
      if (!isRecord(from) || !Object.prototype.hasOwnProperty.call(from, part)) {
        from = undefined
        break
      }
      from = from[part]
    }
    if (from === undefined) continue
    let to = out
    for (const part of parts.slice(0, -1)) {
      if (!isRecord(to[part])) to[part] = Object.create(null)
      to = to[part] as Record<string, unknown>
    }
    to[parts[parts.length - 1]] = from
  }
  return { ...out }
}

/**
 * The store a replay guard writes to. A Workers KV namespace satisfies it
 * (`get` and `put` with `expirationTtl`), as does an in-memory map in tests.
 */
export interface ReplayStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface ReplayGuardOptions {
  store: ReplayStore
  /** How long a delivery id is remembered. Default 600 seconds, twice the
   *  signature primitives' five-minute timestamp window, so an id outlives
   *  every delivery that could still verify. */
  ttlSeconds?: number
  /** Key prefix, so one namespace can hold several guards. Default `replay:`. */
  prefix?: string
}

export interface ReplayGuard {
  /**
   * Record `id` and say whether it was new. Call it after the signature check
   * passes, with the vendor's delivery id (or the signature itself when the
   * vendor sends none). `false` means a replay: answer 2xx without acting, so
   * the vendor stops retrying, or 409 when the vendor treats that as final.
   */
  firstSeen(id: string, scope?: string): Promise<boolean>
  /** Release an id whose handling failed, so the vendor's retry is handled
   *  rather than dropped as a replay. */
  forget(id: string, scope?: string): Promise<void>
}

/**
 * A replay guard over a key-value store. Ids are scoped (pass the installation
 * id) so two installations of one app never share a seen set.
 *
 * Limit: Workers KV is eventually consistent, so two copies of one delivery
 * that arrive at different locations within KV's propagation delay can both
 * read "new". Use a Durable Object behind the same interface where a
 * duplicate side effect is costly (money movement, outbound messages).
 */
export function createReplayGuard(options: ReplayGuardOptions): ReplayGuard {
  const ttl = options.ttlSeconds ?? 600
  const prefix = options.prefix ?? 'replay:'
  const keyOf = (id: string, scope: string) => `${prefix}${scope}:${id}`
  return {
    async firstSeen(id: string, scope = ''): Promise<boolean> {
      if (!id) return false
      const key = keyOf(id, scope)
      if ((await options.store.get(key)) !== null) return false
      await options.store.put(key, '1', { expirationTtl: ttl })
      return true
    },
    async forget(id: string, scope = ''): Promise<void> {
      if (id) await options.store.delete(keyOf(id, scope))
    },
  }
}
