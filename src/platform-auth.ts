/**
 * Caller authentication for platform-to-worker calls: the lifecycle routes
 * and every plain (non-webhook) route.
 *
 * `POST __platform/setup` and `POST __platform/teardown` take `operator_id` and
 * `installation_id` from the request body and act on them: setup writes the
 * install state into the worker's KV store and may hand a credential back to
 * the platform; teardown deletes that state. Before BDOK-1277 neither call
 * carried any caller proof, so anything able to reach `{slug}.bdok.dev` could
 * drive either lifecycle hook for an arbitrary installation id — an
 * unauthenticated cross-tenant write, and a teardown a third party could
 * trigger for an installation that was not theirs.
 *
 * Plain routes had the same gap with more at stake (BDOK-1701): they build
 * their context from the `x-bagdock-installation-id` header, which picks whose
 * stored vendor credentials the handler uses, so a caller who knew an
 * installation id could send SMS or provision numbers on that operator's
 * account. The SDK now verifies the same signature on every plain route.
 *
 * The platform signs all of these calls. The signing counterpart is
 * `apps/operator-api-hono/src/services/adapter-platform-dispatch.ts`; the two
 * files share the canonical string below and the fixture vectors in their
 * tests, which is what keeps them from drifting.
 *
 * Wire format, mirroring the repo's outbound webhook convention
 * (`X-Bagdock-Signature: sha256=<hex>` in `@bagdock/webhook-emitter`):
 *
 *   X-Bagdock-Platform-Timestamp: <unix seconds>
 *   X-Bagdock-Platform-Signature: sha256=<hex HMAC-SHA256>
 *
 * The signed string is `${timestamp}.${method}.${origin}${path}.${rawBody}`.
 *
 * Each component is load-bearing:
 *
 * - The timestamp makes `MAX_CLOCK_SKEW_SECONDS` enforceable. A captured
 *   request cannot be replayed later with a fresh timestamp, because the
 *   attacker cannot re-sign it.
 * - The origin and path bind the call to ONE worker and ONE route, so a captured
 *   call cannot be replayed at a different adapter, or with `setup` swapped for
 *   `teardown`, inside the skew window.
 * - The method stops a signed body being replayed at a different verb.
 *
 * The dispatch headers (`x-bagdock-operator-id`, `x-bagdock-installation-id`,
 * `x-bagdock-environment`, `x-bagdock-install-inputs`) are not in the signed
 * string. A caller without the key cannot sign at all, so cannot reach a plain
 * route; swapping the headers on a captured signed call inside the skew window
 * needs that call in transit, which TLS carries.
 *
 * The origin is compared scheme-and-host only (no port normalisation beyond
 * what `URL` does), because that is what identifies the adapter worker.
 *
 * The key this module verifies with is NOT platform-wide. The platform derives
 * one per worker — `HMAC(root, host)`, see `deriveWorkerSecret` in the signing
 * counterpart — and installs it as this Worker's `BAGDOCK_PLATFORM_SECRET` at
 * deploy. That matters because this code runs inside a script the app author
 * uploaded, so the author can read the key it holds. Under a single shared
 * secret they could not merely replay a captured call but MINT one for any other
 * adapter, which origin-binding would not stop. Per-worker derivation confines a
 * leaked key to the worker its owner already controls. Nothing here depends on
 * the derivation: from this side it is simply the secret the Worker was given.
 *
 * This package is deliberately dependency-free so adapter bundles stay small,
 * so this module uses only WebCrypto, which both the Workers runtime and Node
 * 18+ provide as a global.
 */

export const PLATFORM_AUTH_HEADERS = {
  timestamp: 'x-bagdock-platform-timestamp',
  signature: 'x-bagdock-platform-signature',
} as const

/**
 * How far a lifecycle call's timestamp may sit from the worker's clock. Five
 * minutes matches the outbound webhook receiver guidance and leaves room for
 * the 30s dispatch timeout plus ordinary clock drift between the API and the
 * edge.
 */
export const MAX_CLOCK_SKEW_SECONDS = 300

export type PlatformAuthResult =
  | { ok: true; reason: 'verified' }
  /**
   * `unconfigured`: no secret is set on this worker, so the call cannot be
   * checked and is refused. Until 0.6.0 it was accepted with a warning, which
   * left an adapter deployed without its secret open to any caller (BDOK-1701).
   */
  | { ok: false; reason: 'unconfigured' | 'missing_signature' | 'malformed_signature' | 'stale_timestamp' | 'bad_signature' }

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Constant-time comparison of two equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * `url` is normalised to origin + pathname: a query string or fragment is not
 * part of the lifecycle contract, and including them would make a signature
 * depend on incidental URL shape.
 */
function platformSigningString(
  timestamp: string | number,
  method: string,
  url: string,
  rawBody: string,
): string {
  const u = new URL(url)
  return `${timestamp}.${method.toUpperCase()}.${u.origin}${u.pathname}.${rawBody}`
}

/** HMAC-SHA256 of the canonical signing string, hex-encoded. */
export async function computePlatformSignature(
  secret: string,
  timestamp: string | number,
  method: string,
  url: string,
  rawBody: string,
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(platformSigningString(timestamp, method, url, rawBody)),
  )
  return hex(sig)
}

/**
 * Verify the platform's signature over a request body.
 *
 * `rawBody` must be the exact bytes the platform signed — read the body once
 * as text and hand the same string to both this function and the JSON parse,
 * never a re-serialised object, whose key order and spacing would differ.
 *
 * `secret` absent or empty fails as `unconfigured`: a worker that cannot check
 * the platform's signature refuses the call rather than trusting it.
 */
export async function verifyPlatformRequest(
  request: Request,
  secret: string | undefined | null,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<PlatformAuthResult> {
  if (!secret) return { ok: false, reason: 'unconfigured' }

  const timestamp = request.headers.get(PLATFORM_AUTH_HEADERS.timestamp)
  const header = request.headers.get(PLATFORM_AUTH_HEADERS.signature)
  if (!timestamp || !header) return { ok: false, reason: 'missing_signature' }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || !/^\d+$/.test(timestamp)) {
    return { ok: false, reason: 'malformed_signature' }
  }
  if (Math.abs(nowSeconds - ts) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  const [scheme, provided] = header.split('=', 2)
  if (scheme !== 'sha256' || !provided) {
    return { ok: false, reason: 'malformed_signature' }
  }

  // Signed over THIS request's method and URL, so a signature minted for
  // another adapter's worker, or for the sibling lifecycle route, does not
  // verify here.
  const expected = await computePlatformSignature(
    secret,
    timestamp,
    request.method,
    request.url,
    rawBody,
  )
  if (!timingSafeEqualHex(expected, provided.toLowerCase())) {
    return { ok: false, reason: 'bad_signature' }
  }
  return { ok: true, reason: 'verified' }
}

/** The 401 body a worker returns when verification fails. */
export function platformAuthError(reason: Extract<PlatformAuthResult, { ok: false }>['reason']): Response {
  return Response.json(
    { error: 'Platform authentication failed', reason },
    { status: 401 },
  )
}
