# @bagdock/worker-sdk

## Unreleased

### Minor Changes

- `pickFields(source, fields)` builds an outbound payload from an explicit field allowlist (keys or dotted paths), and `createReplayGuard({ store })` refuses a webhook delivery id it has already seen (`firstSeen`, `forget`). Both serve the app security gate's required controls (BDOK-3216). New types: `ReplayStore`, `ReplayGuard` and `ReplayGuardOptions`.

## 0.9.0

### Minor Changes

- Installed apps receive three platform calls with their installation's context (BDOK-3195). Each is signed with the worker's platform key and carries the dispatch headers and install inputs.
- `bagdockEventsRoute(handlers)` serves the route the platform delivers the manifest's declared `events` to. The body is `BagdockEventDelivery` (`event_id`, `event_type`, `occurred_at`, `data`), dispatched to the handler for its type. A type with no handler answers 200 with `handled: false`; a handler that throws answers 500 and the platform retries.
- `tickRoute(handler)` serves the route the platform calls on the manifest's `tick` interval. The body is `TickDelivery` (`object: 'tick'`, `id`, `scheduled_at`, `interval_seconds`).
- `installationWebhookRoute({ verify, handler })` builds a route kind for vendor webhooks that arrive through the platform's per-installation URL, `/webhooks/apps/{installation_id}/{path}`. The route requires the platform's signature, then builds the context from the dispatch headers, so `verify` checks the vendor's signature over `ctx.rawBody` with the installation's own secret in `ctx.inputs`. A delivery sent straight to the worker is refused with 401. A forwarded GET runs the same route, with the vendor's query string on `ctx.request.url`.
- New types: `BagdockEventDelivery`, `BagdockEventHandler`, `TickDelivery`, `TickHandler`, `InstallationWebhookRouteConfig` and `InstallationWebhookContext`. `RouteEntry` adds `InstallationWebhookRouteConfig`.

## 0.8.0

### Minor Changes

- The comms contract covers buying exact numbers, messaging profiles, alphanumeric senders and US 10DLC registration (BDOK-3142). `CommsCapability` adds `messaging_profile`, `alphanumeric_sender` and `registration`. `AllCommsRoutes` adds `numbers/order`, `numbers/order-status`, `numbers/assign-profile`, `messaging/profile`, `senders/alphanumeric`, `registrations/submit`, `registrations/status`, `registrations/assign-number`, `registrations/usecases` and the verified `webhooks/registration`.
- New types: `OrderNumberParams`, `OrderNumberResult`, `OrderStatusParams`, `ReleaseNumberParams`, `AssignProfileParams`, `AssignProfileResult`, `MessagingProfileParams`, `MessagingProfileResult`, `AlphanumericSenderParams`, `RegistrationSubmitParams`, `RegistrationStatusParams`, `RegistrationResult`, `RegistrationAssignNumberParams`, `RegistrationAssignNumberResult`, `RegistrationUsecase`, `NormalizedRegistrationEvent`, `BrandRegistrationInput`, `CampaignRegistrationInput`, `VettingRegistrationInput`, `QuotedPrice`, `NumberType`, `NumberFeature`, `OrderStatus`, `RegistrationKind` and `RegistrationStatus`. Results an adapter answers from a fixture carry `simulated: true`.
- `SendSMSParams` adds `messagingProfileId`, which Telnyx needs with an alphanumeric `from`.
- `numbers/provision`, `ProvisionNumberParams` and `ProvisionNumberResult` are deprecated and stay for one release.

Breaking within 0.x:

- `NumberSearchParams.type` is `numberType`, and the search adds `locality`, `administrativeArea`, `features` and `contains`.
- `AvailableNumber` replaces `type`, `region` and `monthlyPricePence` with `numberType`, `country`, `locality`, `administrativeArea`, `features`, `monthlyCost` and `upfrontCost` (amount in minor units with the provider's currency) and `requirements`.
- An adapter that declares `numbers` must serve `numbers/search`, `numbers/order` and `numbers/release`. It served `numbers/search` and `numbers/provision` before.
- `ReleaseNumberResult` adds `alreadyReleased` and `providerStatus`.

## 0.7.0

### Minor Changes

- `createSearchWorker` builds a search worker: one platform route, `POST /search`, called by the platform with the operator's own provider key in `ctx.inputs`. The handler receives a checked `SearchRequest` (`query`, `since`, `limit`) and returns the provider's hits. The factory returns `{ results: [{ title, url, published_at, passage }] }`, with `published_at` as a UTC `YYYY-MM-DD` or null, and answers the contract's four error codes: 400 `invalid_query`, 401 `provider_key_rejected`, 429 `provider_rate_limited`, 502 `provider_unavailable`. A handler reports a refused key or a reached limit by throwing `SearchProviderError`. The route requires the platform signature like every plain route. (BDOK-2233)
- New exports: `SearchProviderError`, `SEARCH_QUERY_MAX_LENGTH`, `SEARCH_RESULT_LIMIT_MAX`, and the types `SearchCapability`, `SearchRouteMap`, `SearchWorkerConfig`, `SearchHandler`, `SearchRequest`, `SearchHit`, `SearchResult`, `SearchResponse`, `SearchErrorCode` and `SearchErrorBody`.
- A capabilities-driven worker with no `onInstall` hook reports its `capabilities` in the `__platform/setup` response. 0.6.1 reported them only when the hook was set.

## 0.6.1

### Patch Changes

- A route that declares `verify` runs its verifier before the dispatch headers are read. A direct vendor delivery such as a Stripe webhook carries no `x-bagdock-*` headers, and 0.6.0 and earlier answered it with 400 `Missing dispatch headers` before the signature was checked. The handler of a verified route now receives the dispatch context when the headers are present, and an account-level context (`operatorId` and `installationId` equal to `ACCOUNT_LEVEL_ID`, `environment` `live`, an empty install store) when they are not. (BDOK-568)

## 0.6.0

### Minor Changes

- Every plain route requires the platform signature. A route without `verify` runs only when `X-Bagdock-Platform-Timestamp` and `X-Bagdock-Platform-Signature` verify against `BAGDOCK_PLATFORM_SECRET` over the exact body, the same check the lifecycle routes use. An unsigned call answers 401 before the dispatch headers are read, so a caller who knows an installation id can no longer act on that installation's stored vendor credentials. Routes that declare `verify` (vendor webhooks) and `health` are unchanged. The handler receives the request with its body unread. (BDOK-1701)
- A worker without `BAGDOCK_PLATFORM_SECRET` refuses `__platform/setup`, `__platform/teardown` and every plain route with 401 `unconfigured`. 0.5.0 accepted lifecycle calls unverified in that state.
- `verifyPlatformRequest` returns `{ ok: false, reason: 'unconfigured' }` when the secret is absent. It returned `{ ok: true, reason: 'unconfigured' }` before.
- `createCommsWorker`, `createPaymentsWorker` and `createBagdockWorker` share one route dispatcher, so the three factories authenticate identically.

Breaking within 0.x: deploy an adapter on 0.6.0 only with `BAGDOCK_PLATFORM_SECRET` set, and only once every platform caller of its plain routes signs. The operator API signs comms routes called over the network (`sms/send`, `voice/token`, `voice/call`) and the payments routes. Voice calls through the dispatch namespace (`dispatch`) are signed only when the caller passes the worker URL to `DispatchedVoiceAdapter`.

## 0.5.0

### Minor Changes

- `hmacSha256Verify` and `ed25519Verify` fail closed on a missing timestamp. A `timestamp` that is `undefined`, `null` or empty now returns a 401 (`Missing webhook timestamp`) instead of skipping the replay window. Callers that pass `request.headers.get(...)` no longer accept a request whose timestamp header was dropped. (BDOK-1649)
- New `requireTimestamp` option on both primitives, default `true`. Set it to `false` only for a vendor that signs without a timestamp. A timestamp that is present is still checked against `toleranceMs`.
- A timestamp must be whole Unix seconds, digits only. Anything else is rejected as invalid, including fractional seconds (`1700000000.123`) and trailing characters (`1700000000abc`), which 0.4.0 truncated with `parseInt` and accepted.

Breaking within 0.x: a verifier that omits `timestamp` now returns 401. Pass the vendor's timestamp, or set `requireTimestamp: false` if the vendor does not sign one.
