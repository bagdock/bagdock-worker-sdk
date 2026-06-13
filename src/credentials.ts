/**
 * Platform credential surface (`ctx.credentials`).
 *
 * An adapter declares *what* per-operator secret to store; the PLATFORM seals it
 * server-side with the platform KMS (the managed-vault model). This SDK contains
 * NO crypto and no KMS access on purpose: `@bagdock/worker-sdk` is published to
 * npm, so shipping the Infisical endpoints / auth flow / key ids here would leak
 * our secrets backend to anyone who installs the package. Sealing stays entirely
 * in the private, server-side `@bagdock/crypto` (BDOK-557).
 *
 * Flow: the worker hands the raw payload back to the platform over the trusted
 * dispatch channel (the same authenticated TLS path the platform already uses to
 * call `__platform/setup`); the control-plane ingest seals it before it ever
 * touches the database. The adapter never holds a key and never performs crypto.
 *
 * For OAuth-on-install (the common shape) the worker does not handle tokens at
 * all — the platform's managed OAuth broker + token vault own that path.
 */

/** Context an adapter supplies so the platform can bind the ciphertext (AAD). */
export interface CredentialAadContext {
  /**
   * A stable label for what is being stored (e.g. `'stripe_sandbox_key'`). The
   * platform combines it with operator/installation context to build the AAD, so
   * a ciphertext cannot be replayed into another field or installation. It is a
   * label only — never put secret material here.
   */
  field: string
}

/**
 * A credential payload an adapter has handed to the platform to seal. It carries
 * the RAW payload (the worker has no key) plus the field label the platform binds
 * the ciphertext to. The platform seals it server-side on ingest; the worker
 * never sees, and cannot produce, the sealed envelope.
 */
export interface PreparedCredential {
  /** Marks the credential-carrying shape for the platform ingest. */
  readonly __sealOnIngest: true
  /** Raw credential object the platform will seal with the platform KMS. */
  readonly payload: Record<string, unknown>
  /** Field label fed into the platform's AAD binding. */
  readonly field: string
}

export interface CredentialsProvider {
  /**
   * Hand a per-operator secret to the platform to store securely. Returns a
   * {@link PreparedCredential} to set as `connected_account.credential`; the
   * platform seals it server-side. The adapter performs no crypto.
   */
  store(
    payload: Record<string, unknown>,
    ctx: CredentialAadContext,
  ): PreparedCredential
}

export function createCredentialsProvider(): CredentialsProvider {
  return {
    store(payload, ctx) {
      return { __sealOnIngest: true, payload, field: ctx.field }
    },
  }
}

/**
 * Type guard for the credential-carrying shape — used by the SDK to assert that
 * a credential-bearing install handed over a {@link PreparedCredential} (not a
 * bare secret), and usable by the control-plane ingest before it seals.
 */
export function isPreparedCredential(value: unknown): value is PreparedCredential {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __sealOnIngest?: unknown }).__sealOnIngest === true
  )
}
