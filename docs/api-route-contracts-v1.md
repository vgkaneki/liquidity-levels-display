# API Route Contracts V1

This document records the repo-side API input contracts that have been hardened so far. It is focused on route-boundary behavior only and does not describe or modify protected engine logic.

## Protected engine boundary

These contracts do not change liquidity and structural level formulas, confluence and scoring formulas, touch classification, DOM and Bookmap logic, absorption logic, scanner scoring, reversal scoring, or level placement math.

## Watchlists

- Names are trimmed and capped.
- Symbols are canonicalized before persistence.
- Add and delete symbol routes validate symbol format.
- Reorder requests are capped and de-duplicated before storage.
- User ownership is enforced by route/user id scoping.

Marker: `watchlistInputHardeningV1`.

## Alerts

- Names are required and capped.
- Kind and sink values are allow-listed.
- Symbols support concrete symbols, `*`, and owned list scopes.
- Params payloads are capped.
- External sink URLs are validated before storage.
- Rule, history, mute, and delivery ids are checked before lookup or mutation.
- Throttle, history limit, and mute durations are bounded.

Marker: `alertRouteInputHardeningV1`.

## Push subscriptions

- Endpoints are trimmed, parsed, normalized, and must use HTTPS.
- Local/private endpoint hosts are rejected.
- Subscription keys are trimmed, length checked, and format checked.
- Subscribe and unsubscribe use the normalized endpoint for duplicate detection and deletion.

Marker: `pushRouteInputHardeningV1`.

## Symbols

- Search queries are trimmed, uppercased, capped, and format checked.
- Debug params are trimmed, uppercased, capped, and format checked.
- Exchange filters are allow-listed.
- List/search limits remain bounded.

Marker: `symbolRouteInputHardeningV1`.

## Screener proxy

- Sidecar port is parsed and constrained to a valid TCP port.
- Catalog query strings are capped.
- Catalog query keys and values are capped.
- Scan request payloads must fit the configured size cap.
- Sidecar timeout behavior stays bounded.

Marker: `screenerProxyInputHardeningV1`.

## HL validation

- Historical profile validation now reports the complete supported profile list.
- Historical risk overrides are bounded before they reach the job manager.
- Run ids are trimmed and format checked before lookup, report, or cancel handling.
- Forward validation symbols and intervals are allow-listed, capped, and de-duplicated.
- Forward validation duration, poll cadence, target, stop, timeout, fee, and slippage options are bounded.

Marker: `hlValidationRouteInputHardeningV1`.

## Render verification

The Render build path runs both the general build verifier and the route-input hardening verifier. The route-input verifier now checks watchlist, alert, push, symbol, screener proxy, and HL validation markers.

## Test coverage

The API server test script now includes `src/routes/routeInputHardening.test.ts`, which checks that route-boundary hardening markers remain present for watchlists, alerts, push, symbol, screener proxy, and HL validation routes.

## Remaining repo-side route contract work

- Add behavioral tests for accepted and rejected inputs on hardened routes.
- Add schema docs for remaining specialized endpoints.
- Expand verifier coverage as additional route markers are added.
