# Real-Time Financial Data Risk Register V1

This register maps the 50 production risks raised during review into the platform work queue. It is repo-side documentation only and does not modify protected engine logic.

## Protected engine boundary

Do not change liquidity and structural level formulas, confluence and scoring formulas, touch classification, DOM and Bookmap logic, absorption logic, scanner scoring, reversal scoring, or level placement math while addressing these items. Changes should stay at route boundaries, feed adapters, runtime plumbing, documentation, tests, deployment, and monitoring unless explicitly reviewed.

## Current highest-priority implementation targets

1. Real-time update pressure: tick throttling, requestAnimationFrame batching, bounded queues, and slow-client backpressure.
2. Exchange feed correctness: snapshots plus deltas, stale-feed detection, timestamp normalization, exchange-specific error handling, and rate-limit handling.
3. Financial aggregation correctness: volume-weighted price/liquidity aggregation, attribution for cross-exchange spread, common quote currency normalization, and stale venue exclusion.
4. Frontend performance: no per-tick React render loops, no heavy order-book aggregation on the main thread, memory caps for old chart data, and optional workers for heavy transforms.
5. Production operations: data freshness alerts, latency degradation alerts, replay/simulation testing, load testing, runbooks, and deployment rollback strategy.

## Issue map

| # | Risk | Priority | Platform disposition |
|---:|---|---|---|
| 1 | High-frequency update throttling | P0 | Must remain enforced on WebSocket and chart update paths. Verify RAF/coalesced UI updates and server-side throttles. |
| 2 | Update batching inefficiency | P0 | Batch deltas before React state/canvas updates. Avoid one render per tick. |
| 3 | Missing snapshots and deltas | P0 | Order book feeds should use an initial snapshot plus bounded delta stream with resync on sequence gaps where vendor data supports it. |
| 4 | Inefficient order book aggregation | P0 | Prefer server-side or worker-side aggregation; do not aggregate deep books on the main UI thread. |
| 5 | WebSocket message queue overflow | P0 | Add/verify bounded send queues and drop/coalesce behavior for slow clients. |
| 6 | Timestamp synchronization issues | P0 | Normalize vendor timestamps into one clock domain and preserve exchange attribution. |
| 7 | Incorrect price aggregation | P0 | Use volume-weighted or liquidity-weighted aggregation where multiple venues contribute. Do not use a naive average for liquidity views. |
| 8 | Missing currency conversion | P1 | Normalize display to a common quote currency where multi-quote assets are combined. |
| 9 | No handling of stale data | P0 | Mark stale venues and exclude stale feeds from aggregate decisions after a configured TTL. |
| 10 | Incorrect spread calculation | P0 | Keep venue attribution for bid/ask and label cross-exchange spreads separately from same-venue spreads. |
| 11 | Missing market-hours consideration | P3 | Mostly not applicable to 24/7 crypto, but still relevant for any future equities/futures integrations. |
| 12 | Exchange API rate limit handling | P0 | Enforce per-exchange rate limiters, backoff, and cooldowns. |
| 13 | Missing exchange-specific error handling | P1 | Normalize outage/maintenance/auth/rate-limit errors per adapter. |
| 14 | Inefficient exchange data normalization | P1 | Normalize once at the adapter boundary; avoid repeated UI-side transformations. |
| 15 | No fallback exchanges | P1 | Add fallback policy per symbol; never silently blend fallback data without labeling source quality. |
| 16 | Poor color choices for liquidity levels | P2 | Keep accessible palette options and document meaning. Avoid misleading red-only semantics. |
| 17 | Missing tooltips and explanations | P2 | Add UI help for spread, depth, liquidity, stale, venue, confidence, and aggregation mode. |
| 18 | No chart scaling options | P2 | Support auto, fixed, recent-range, and manual scaling modes where practical. |
| 19 | Lack of real-time vs historical toggle | P2 | Add explicit live/replay/historical state in UI and APIs. |
| 20 | No export functionality | P2 | Export snapshots, selected ranges, and level/heatmap data as CSV/JSON. |
| 21 | Missing data partitioning | P1 | Partition persisted data by exchange, symbol, interval, and time bucket. |
| 22 | No stream processing | P2 | Current app can run without Kafka/Flink, but design should allow a future stream processor. |
| 23 | Missing horizontal scaling | P1 | Make connection/session state safe for multi-instance deployment before production scaling. |
| 24 | No data replay mechanism | P1 | Add capture and replay tooling for feed bugs, QA, and regression tests. |
| 25 | No anomaly detection | P1 | Alert on liquidity cliffs, extreme spread, stalled books, and venue divergence. |
| 26 | Missing data freshness alerts | P0 | Alert when a venue/symbol feed exceeds freshness TTL. |
| 27 | No performance degradation alerts | P0 | Alert on increased feed-to-render latency, queue depth, dropped/coalesced updates, and slow route timings. |
| 28 | Inefficient time-series storage | P2 | Avoid high-frequency hot-path writes to plain relational tables without batching/retention. |
| 29 | No data archiving strategy | P2 | Move older high-frequency data into compressed cold storage. |
| 30 | Missing historical compression | P2 | Compress historical capture/replay data. |
| 31 | Canvas/WebGL vs DOM misuse | P0 | Keep high-volume chart and book visuals on canvas/WebGL; avoid per-point DOM nodes. |
| 32 | Missing workers for processing | P1 | Use Web Workers for heavy transforms when server-side aggregation is not enough. |
| 33 | Inefficient chart memory usage | P0 | Cap retained arrays, release old buffers, and test memory over long sessions. |
| 34 | No UI throttling | P0 | UI must never process every tick if the render loop is behind. |
| 35 | Inefficient order-book structures | P1 | Use maps/trees/bucketed structures for update-heavy books; avoid repeated full-array scans in hot paths. |
| 36 | No DB connection pooling | P1 | Verify pooled DB access for all persistent writes. |
| 37 | Missing write batching | P1 | Batch inserts for ticks, snapshots, captures, and alert events. |
| 38 | No data integrity verification | P2 | Support vendor checksums/sequences where available and log resyncs. |
| 39 | Missing audit trail | P2 | Audit configuration, data-source, alert, and user-facing operational changes. |
| 40 | GDPR/privacy compliance | P2 | Keep user data minimal, document retention, and avoid logging secrets/personal data. |
| 41 | No exchange data simulation | P1 | Add deterministic exchange simulators for adapters, stale feeds, gaps, bursts, and rate limits. |
| 42 | Missing load testing | P1 | Add WebSocket and real-time route load tests before production scale. |
| 43 | No chaos testing | P2 | Simulate exchange outage, latency, reconnect storms, and packet loss. |
| 44 | No blue-green deployment | P2 | Use zero-downtime deployment plan for live WebSocket users. |
| 45 | Missing large migration strategy | P2 | Plan time-series migrations with backfills, dual writes, and rollback. |
| 46 | Hardcoded exchange config | P1 | Move endpoints, limits, and feature flags to typed configuration. |
| 47 | No dynamic config reload | P2 | Add safe reload or admin-driven refresh for exchange config where needed. |
| 48 | Missing architecture diagrams | P2 | Add data-flow diagram for exchange feeds, normalizers, aggregation, WebSocket, UI, storage, and replay. |
| 49 | No production runbook | P1 | Add runbooks for stale exchange feed, high latency, WebSocket overload, failed deploy, and bad vendor data. |
| 50 | Inconsistent exchange error handling | P1 | Standardize adapter error categories and telemetry fields. |

## Safe fix order

1. Add runtime/verifier coverage for current high-frequency protections and queue caps.
2. Add data freshness/staleness telemetry and visible stale-source state.
3. Add exchange adapter error categories and rate-limit/backoff documentation/tests.
4. Add feed simulator and replay fixtures for snapshot, delta, stale, burst, reconnect, and out-of-order cases.
5. Add frontend long-session memory tests and worker/server-side aggregation boundaries.
6. Add operational runbooks and diagrams for production handoff.

## Items that are mostly external to this repo right now

- Blue-green deployment setup.
- WAF/CDN and provider-level TLS settings.
- Cloud database migration windows and managed backup/restore drills.
- External observability stack, uptime monitors, APM, log aggregation, and alert routing.
- Kafka/Flink or dedicated stream-processing infrastructure.

## Verification expectation

Every code-side mitigation should add at least one of the following:

- A route/runtime verifier marker.
- A unit or marker test.
- A replay/simulator scenario.
- A production runbook entry.
- A Render verification check when it protects startup/build/deploy behavior.
