/**
 * The search contract, held against two fixture providers (BDOK-2233).
 *
 * `alpha` and `beta` stand for two search providers whose native APIs differ in
 * every way a real pair does: field names, how a passage comes back, the date
 * format, where the key goes and how a failure is reported. Each is wrapped in
 * a worker built with `createSearchWorker`. The same signed `POST /search`
 * then returns the same response from both, and each provider's own failures
 * arrive as the contract's four error codes.
 *
 * The fixtures call nothing: each provider is a function over one page list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSearchWorker, SearchProviderError } from '../create-search-worker'
import { PLATFORM_SECRET_BINDING } from '../create-worker'
import { computePlatformSignature, PLATFORM_AUTH_HEADERS } from '../platform-auth'
import { SEARCH_QUERY_MAX_LENGTH } from '../types'
import type { BaseEnv, SearchHandler, SearchRequest } from '../types'

const KEY = 'worker_derived_key_fixture'
const OPERATOR_KEY = 'operator_own_provider_key'

const PAGES = [
  {
    title: 'New storage facility opens in Didsbury',
    url: 'https://didsburypost.example/storage-opens',
    published: '2026-10-20T08:30:00.000Z',
    text: 'The 380-unit site opened on Monday.',
  },
  {
    title: 'Council approves homes on the old depot site',
    url: 'https://didsburypost.example/depot-homes',
    published: null,
    text: 'Planning officers backed 140 homes on the former bus depot.',
  },
  {
    title: 'Student lets rise across south Manchester',
    url: 'https://mcrledger.example/student-lets',
    published: '2026-09-02T17:05:00.000Z',
    text: 'Agents report the busiest September in five years.',
  },
]

type ProviderFailure = 'bad_key' | 'rate_limited' | 'down' | null
let failure: ProviderFailure = null
let extraHits: Array<Record<string, unknown>> = []

// --- Provider alpha: camelCase, ISO date-times, snippets as an array, a status code on failure.

function alphaApi(key: string, body: { query: string; numResults: number; startPublishedDate: string }) {
  if (key !== OPERATOR_KEY || failure === 'bad_key') throw Object.assign(new Error('alpha: key not recognised for account 4471'), { status: 401 })
  if (failure === 'rate_limited') throw Object.assign(new Error('alpha: 10 QPS exceeded'), { status: 429 })
  if (failure === 'down') throw Object.assign(new Error('alpha: upstream overloaded'), { status: 503 })
  return {
    results: PAGES
      .filter((p) => !p.published || p.published >= body.startPublishedDate)
      .slice(0, body.numResults)
      .map((p) => ({ title: p.title, url: p.url, ...(p.published ? { publishedDate: p.published } : {}), highlights: [p.text] })),
  }
}

const alphaSearch: SearchHandler<BaseEnv> = async (ctx, request) => {
  try {
    const { results } = alphaApi(ctx.inputs.api_key ?? '', {
      query: request.query,
      numResults: request.limit,
      startPublishedDate: `${request.since}T00:00:00.000Z`,
    })
    return [
      ...results.map((r) => ({ title: r.title, url: r.url, published_at: r.publishedDate, passage: r.highlights.join(' ') })),
      ...extraHits,
    ]
  } catch (err: any) {
    if (err.status === 401) throw new SearchProviderError('provider_key_rejected', err.message)
    if (err.status === 429) throw new SearchProviderError('provider_rate_limited', err.message)
    throw err
  }
}

// --- Provider beta: snake_case, RFC 1123 dates or null, one content string, a result object on failure.

function betaApi(authorization: string, body: { query: string; max_results: number; start_date: string }) {
  if (authorization !== `Bearer ${OPERATOR_KEY}` || failure === 'bad_key') return { ok: false as const, code: 401, detail: { error: 'beta: invalid API key bk-991' } }
  if (failure === 'rate_limited') return { ok: false as const, code: 429, detail: { error: 'beta: 100 requests a minute exceeded' } }
  if (failure === 'down') return { ok: false as const, code: 500, detail: { error: 'beta: internal error' } }
  return {
    ok: true as const,
    results: PAGES
      .filter((p) => !p.published || p.published.slice(0, 10) >= body.start_date)
      .slice(0, body.max_results)
      .map((p) => ({
        title: p.title,
        url: p.url,
        content: p.text,
        published_date: p.published ? new Date(p.published).toUTCString() : null,
        score: 0.8,
      })),
  }
}

const betaSearch: SearchHandler<BaseEnv> = async (ctx, request) => {
  const res = betaApi(`Bearer ${ctx.inputs.api_key ?? ''}`, {
    query: request.query,
    max_results: request.limit,
    start_date: request.since,
  })
  if (!res.ok) {
    if (res.code === 401) throw new SearchProviderError('provider_key_rejected', res.detail.error)
    if (res.code === 429) throw new SearchProviderError('provider_rate_limited', res.detail.error)
    throw new Error(res.detail.error)
  }
  return [
    ...res.results.map((r) => ({ title: r.title, url: r.url, published_at: r.published_date, passage: r.content })),
    ...extraHits,
  ]
}

const PROVIDERS: Array<[string, string, SearchHandler<BaseEnv>]> = [
  ['alpha', 'https://alpha-search.bdok.dev', alphaSearch],
  ['beta', 'https://beta-search.bdok.dev', betaSearch],
]

const seen: SearchRequest[] = []
const recording = (handler: SearchHandler<BaseEnv>): SearchHandler<BaseEnv> => async (ctx, request) => {
  seen.push(request)
  return handler(ctx, request)
}

const make = (handler: SearchHandler<BaseEnv>) =>
  createSearchWorker<BaseEnv>({ capabilities: ['web_search'], routes: { search: recording(handler) } })

const REQUEST = { query: 'Didsbury self storage opening', since: '2026-10-01', limit: 5 }

const installInputs = (inputs: Record<string, string>) => btoa(JSON.stringify(inputs))

async function post(
  origin: string,
  handler: SearchHandler<BaseEnv>,
  route: string,
  body: unknown,
  opts: { sign?: boolean; apiKey?: string | null; env?: BaseEnv } = {},
): Promise<Response> {
  const url = `${origin}/${route}`
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const ts = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-bagdock-operator-id': 'opreg_1',
    'x-bagdock-installation-id': 'ainst_1',
    'x-bagdock-environment': 'live',
  }
  if (opts.apiKey !== null) headers['x-bagdock-install-inputs'] = installInputs({ api_key: opts.apiKey ?? OPERATOR_KEY })
  if (opts.sign !== false) {
    headers[PLATFORM_AUTH_HEADERS.timestamp] = String(ts)
    headers[PLATFORM_AUTH_HEADERS.signature] = `sha256=${await computePlatformSignature(KEY, ts, 'POST', url, raw)}`
  }
  const req = new Request(url, { method: 'POST', headers, body: raw })
  return make(handler).fetch!(req as any, (opts.env ?? { [PLATFORM_SECRET_BINDING]: KEY }) as any, {} as any) as Promise<Response>
}

const search = (origin: string, handler: SearchHandler<BaseEnv>, body: unknown = REQUEST, opts = {}) =>
  post(origin, handler, 'search', body, opts)

beforeEach(() => {
  failure = null
  extraHits = []
  seen.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the same call returns the same response from both providers', () => {
  it('returns one shape, with dates as YYYY-MM-DD and null where the provider has none', async () => {
    const bodies = await Promise.all(PROVIDERS.map(async ([, origin, handler]) => {
      const res = await search(origin, handler)
      expect(res.status).toBe(200)
      return res.json()
    }))

    expect(bodies[0]).toEqual({
      results: [
        {
          title: 'New storage facility opens in Didsbury',
          url: 'https://didsburypost.example/storage-opens',
          published_at: '2026-10-20',
          passage: 'The 380-unit site opened on Monday.',
        },
        {
          title: 'Council approves homes on the old depot site',
          url: 'https://didsburypost.example/depot-homes',
          published_at: null,
          passage: 'Planning officers backed 140 homes on the former bus depot.',
        },
      ],
    })
    expect(bodies[1]).toEqual(bodies[0])
  })
})

describe.each(PROVIDERS)('provider %s', (_name, origin, handler) => {
  it('hands the handler the validated request, trimmed', async () => {
    await search(origin, handler, { ...REQUEST, query: `  ${REQUEST.query}  ` })
    expect(seen).toEqual([REQUEST])
  })

  it('returns no more than the limit, whatever the provider sends back', async () => {
    extraHits = [{ title: 'One too many', url: 'https://mcrledger.example/extra', passage: 'A hit past the limit.' }]
    const res = await search(origin, handler, { ...REQUEST, since: '2026-01-01', limit: 2 })
    expect(((await res.json()) as any).results.map((r: any) => r.url)).toEqual([
      'https://didsburypost.example/storage-opens',
      'https://didsburypost.example/depot-homes',
    ])
  })

  it('leaves out a hit with no http URL or no passage, and a dated hit older than since', async () => {
    extraHits = [
      { title: 'No link', url: null, passage: 'A passage with nowhere to point.' },
      { title: 'Not a web link', url: 'mailto:news@didsburypost.example', passage: 'A passage.' },
      { title: 'No passage', url: 'https://didsburypost.example/empty', passage: '   ' },
      { title: 'Too old', url: 'https://didsburypost.example/old', published_at: '2026-09-30T23:59:59Z', passage: 'From the month before.' },
      { url: 'https://didsburypost.example/untitled', published_at: 'not a date', passage: 'A page with no title and no readable date.' },
    ]
    const { results } = (await (await search(origin, handler, { ...REQUEST, limit: 10 })).json()) as any
    expect(results.map((r: any) => r.url)).toEqual([
      'https://didsburypost.example/storage-opens',
      'https://didsburypost.example/depot-homes',
      'https://didsburypost.example/untitled',
    ])
    expect(results[2]).toEqual({
      title: '',
      url: 'https://didsburypost.example/untitled',
      published_at: null,
      passage: 'A page with no title and no readable date.',
    })
  })

  it.each([
    ['an empty query', { ...REQUEST, query: '   ' }, 'query'],
    ['a query over the limit', { ...REQUEST, query: 'x'.repeat(SEARCH_QUERY_MAX_LENGTH + 1) }, 'query'],
    ['a missing query', { since: REQUEST.since, limit: 5 }, 'query'],
    ['a body that is not JSON', 'not json', 'query'],
    ['a since that is not a date', { ...REQUEST, since: '20 October' }, 'since'],
    ['a since that is not a real day', { ...REQUEST, since: '2026-02-30' }, 'since'],
    ['a limit of 0', { ...REQUEST, limit: 0 }, 'limit'],
    ['a limit over 10', { ...REQUEST, limit: 11 }, 'limit'],
    ['a limit that is not an integer', { ...REQUEST, limit: '5' }, 'limit'],
  ])('answers 400 invalid_query to %s without calling the provider', async (_case, body, param) => {
    const res = await search(origin, handler, body)
    expect(res.status).toBe(400)
    const { error } = (await res.json()) as any
    expect(error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_query', param })
    expect(seen).toEqual([])
  })

  it('accepts a query of exactly the longest length', async () => {
    const res = await search(origin, handler, { ...REQUEST, query: 'x'.repeat(SEARCH_QUERY_MAX_LENGTH) })
    expect(res.status).toBe(200)
  })

  it.each([
    ['bad_key', 401, 'authentication_error', 'provider_key_rejected'],
    ['rate_limited', 429, 'rate_limit_error', 'provider_rate_limited'],
    ['down', 502, 'api_error', 'provider_unavailable'],
  ] as const)('maps the provider failing with %s to %i %s', async (mode, status, type, code) => {
    failure = mode
    const res = await search(origin, handler)
    expect(res.status).toBe(status)
    const body = (await res.json()) as any
    expect(body.error).toMatchObject({ type, code })
    // The provider's own message stays in the worker's logs.
    expect(JSON.stringify(body)).not.toMatch(/alpha|beta|4471|bk-991/)
  })

  it('reports a provider error whose code is outside the contract as provider_unavailable', async () => {
    const res = await search(origin, async () => {
      throw new SearchProviderError('provider_quota_exceeded' as any, 'out of credit on account 4471')
    })
    expect(res.status).toBe(502)
    expect(((await res.json()) as any).error.code).toBe('provider_unavailable')
  })

  it.each([
    ['2026-10-20', '2026-10-20'],
    ['2026-10-20T08:30:00', '2026-10-20'],
    ['2026-10-20T23:30:00-05:00', '2026-10-21'],
    ['Tue, 20 Oct 2026 08:30:00 GMT', '2026-10-20'],
    ['2026-02-30', null],
    ['October 20, 2026', null],
    ['Issue 5', null],
    ['2026', null],
    ['', null],
  ])('reads the date %j as %j', async (given, expected) => {
    extraHits = [{ title: 'Dated', url: 'https://mcrledger.example/dated', published_at: given, passage: 'A dated page.' }]
    const { results } = (await (await search(origin, handler, { ...REQUEST, limit: 10 })).json()) as any
    expect(results.find((r: any) => r.url === 'https://mcrledger.example/dated').published_at).toBe(expected)
  })

  it('reads the operator\'s key from the install inputs, and reports a wrong one as provider_key_rejected', async () => {
    const res = await search(origin, handler, REQUEST, { apiKey: 'someone_elses_key' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('provider_key_rejected')

    const none = await search(origin, handler, REQUEST, { apiKey: null })
    expect(none.status).toBe(401)
    expect(((await none.json()) as any).error.code).toBe('provider_key_rejected')
  })

  it('refuses a call without the platform signature', async () => {
    const res = await search(origin, handler, REQUEST, { sign: false })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Platform authentication failed', reason: 'missing_signature' })
    expect(seen).toEqual([])
  })

  it('refuses a signed call when the worker holds no platform secret', async () => {
    const res = await search(origin, handler, REQUEST, { env: {} })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).reason).toBe('unconfigured')
    expect(seen).toEqual([])
  })

  it('serves no other platform route', async () => {
    const res = await post(origin, handler, 'answer', REQUEST)
    expect(res.status).toBe(404)
    expect(seen).toEqual([])
  })

  it('reports its capability at setup', async () => {
    const res = await post(origin, handler, '__platform/setup', {
      operator_id: 'opreg_1',
      installation_id: 'ainst_1',
      environment: 'test',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ installation_state: {}, capabilities: ['web_search'] })
  })
})
