/**
 * createSearchWorker — Search contract factory.
 *
 * A search worker serves one platform route, `POST /search`, and the factory
 * owns its wire shape: it validates the request, hands the handler a typed
 * `SearchRequest`, and turns the handler's hits and failures into the
 * contract's response and error codes. A provider worker only maps fields, so
 * the platform gets the same shape from every provider.
 *
 * The route is a plain route: it runs only on a call carrying the platform
 * signature, like every other non-webhook route (`dispatchRoute`).
 */

import type {
  BaseEnv,
  RouteHandler,
  SearchErrorBody,
  SearchErrorCode,
  SearchHandler,
  SearchHit,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchWorkerConfig,
} from './types'
import { SEARCH_QUERY_MAX_LENGTH, SEARCH_RESULT_LIMIT_MAX } from './types'
import { buildWorker } from './create-worker'

/** The codes a handler may report; `invalid_query` is the factory's own. */
type ProviderErrorCode = Exclude<SearchErrorCode, 'invalid_query'>

/**
 * Thrown by a search handler when the provider refuses the call. `message` is
 * for the worker's logs; the response carries the contract's own text.
 */
export class SearchProviderError extends Error {
  readonly code: ProviderErrorCode

  constructor(code: ProviderErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'SearchProviderError'
    this.code = code
  }
}

const SEARCH_ERRORS: Record<
  SearchErrorCode,
  { status: number; type: SearchErrorBody['error']['type']; message: string }
> = {
  invalid_query: { status: 400, type: 'invalid_request_error', message: 'The query is empty or too long.' },
  provider_key_rejected: { status: 401, type: 'authentication_error', message: "The provider refused the operator's key." },
  provider_rate_limited: { status: 429, type: 'rate_limit_error', message: "The provider's limit was reached." },
  provider_unavailable: { status: 502, type: 'api_error', message: 'The provider failed or timed out.' },
}

function searchError(code: ProviderErrorCode): Response {
  const { status, type, message } = SEARCH_ERRORS[code]
  const body: SearchErrorBody = { error: { type, code, message } }
  return Response.json(body, { status })
}

/** The contract has one request error code; `param` says which field it is about. */
function invalidQuery(param: keyof SearchRequest, message: string): Response {
  const { status, type } = SEARCH_ERRORS.invalid_query
  const body: SearchErrorBody = { error: { type, code: 'invalid_query', message, param } }
  return Response.json(body, { status })
}

/** A code from outside the contract, thrown by an untyped caller, is not passed on. */
function providerCode(err: unknown): ProviderErrorCode {
  const code = err instanceof SearchProviderError ? err.code : undefined
  return code && code !== ('invalid_query' as string) && code in SEARCH_ERRORS ? code : 'provider_unavailable'
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True for a real calendar day written `YYYY-MM-DD`. */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const time = Date.parse(`${value}T00:00:00Z`)
  // `2026-02-30` parses to 2 March; only a date that reads back the same is real.
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
}

/** The checked request, or the 400 to send. */
function parseSearchRequest(body: unknown): SearchRequest | Response {
  const { query, since, limit } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (!trimmed) return invalidQuery('query', 'The query is empty.')
  if (trimmed.length > SEARCH_QUERY_MAX_LENGTH) {
    return invalidQuery('query', `The query is longer than ${SEARCH_QUERY_MAX_LENGTH} characters.`)
  }
  if (!isCalendarDate(since)) return invalidQuery('since', 'since is not a YYYY-MM-DD date.')
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_RESULT_LIMIT_MAX) {
    return invalidQuery('limit', `limit is not an integer from 1 to ${SEARCH_RESULT_LIMIT_MAX}.`)
  }
  return { query: trimmed, since, limit }
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const ZONELESS_ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]*)?$/
const ZONED = /\b\d{4}\b.*(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i

/** An ISO 8601 date or date-time with no zone, taken as written: shifting it would guess one. */
function zonelessIsoDate(text: string): string | null {
  const day = ZONELESS_ISO.exec(text)?.[1]
  return isCalendarDate(day) ? day : null
}

/** A dated string that states its zone (an ISO date-time, or RFC 1123 as HTTP dates are written), in UTC. */
function zonedDate(text: string): string | null {
  const time = ZONED.test(text) ? Date.parse(text) : Number.NaN
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10)
}

/**
 * A provider's date string as a UTC `YYYY-MM-DD`, or null. Only the two forms
 * above are read: `Date.parse` alone reads `Issue 5` as a day in 2001, and
 * reads other zoneless strings in the runtime's own zone.
 */
function publishedDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return zonelessIsoDate(text) ?? zonedDate(text)
}

/** A hit as the contract returns it, or null for one with no URL or no passage. */
function toResult(hit: SearchHit): SearchResult | null {
  const url = httpUrl(hit?.url)
  const passage = typeof hit?.passage === 'string' ? hit.passage.trim() : ''
  if (!url || !passage) return null
  return {
    title: typeof hit.title === 'string' ? hit.title.trim() : '',
    url,
    published_at: publishedDate(hit.published_at),
    passage,
  }
}

function searchRoute<E extends BaseEnv>(handler: SearchHandler<E>): RouteHandler<E> {
  return async (ctx) => {
    const request = parseSearchRequest(await ctx.request.json().catch(() => null))
    if (request instanceof Response) return request

    let hits: SearchHit[]
    try {
      hits = await handler(ctx, request)
      if (!Array.isArray(hits)) throw new TypeError('search handler did not return an array')
    } catch (err: unknown) {
      // The full error stays in the worker's logs: a provider's message can
      // carry account detail that must not reach the caller.
      console.error('[worker-sdk/search] search error:', err)
      return searchError(providerCode(err))
    }

    // A dated result older than `since` is dropped here, so the filter holds
    // whatever the provider did with it. An undated result is kept.
    const results = hits
      .map(toResult)
      .filter((r): r is SearchResult => r !== null && (r.published_at === null || r.published_at >= request.since))
      .slice(0, request.limit)
    const body: SearchResponse = { results }
    return Response.json(body)
  }
}

/**
 *   createSearchWorker<Env>({ capabilities: ['web_search'], routes: { search } })
 */
export function createSearchWorker<E extends BaseEnv>(config: SearchWorkerConfig<E>): ExportedHandler<E> {
  return buildWorker<E>(
    {
      version: config.version,
      onInstall: config.onInstall,
      onUninstall: config.onUninstall,
      healthCheck: config.healthCheck,
      routes: { search: searchRoute(config.routes.search) },
    },
    { capabilities: config.capabilities, logTag: 'worker-sdk/search' },
  )
}
