# History source diagnostics contract

Local development candidate; no release implied.

Single history GET errors preserve `error` and `requestId`. History database
failures add `diagnostic` with `code`, `scope` (`source`, `database`, `request`),
`phase` (`schema`, `query`), `tables` and a safe `action`. Batch range and lazy
batch last-value recovery use the same object on the failed result. Batch HTTP
200 still requires clients to inspect each result's `status`/`error`.

| Code | Status | Meaning |
| --- | --- | --- |
| HISTORY_TABLE_MISSING | 409 | QuestDB named a missing table selected by this request. |
| HISTORY_DATABASE_UNAVAILABLE | 503 | Database transport or server unavailable; no per-table blame. |
| HISTORY_DATABASE_TIMEOUT | 503 | Database request deadline expired. |
| HISTORY_DATABASE_ACCESS_DENIED | 503 | Service-to-database credentials or permissions failed. |
| HISTORY_READ_FAILED | 409 | Query rejected; no reliable individual source attribution. |

Caller authentication/authorization retains its existing 401/403 contract and
runs before source discovery. Unknown application failures remain generic 500.
Raw upstream messages, credentials, URLs and SQL are not diagnostic fields.

Automatic multi-source history is atomic at the response boundary: one failing
source fails that series, without silently returning a healthy subset. Explicit
selection of a healthy table is a separate caller decision. Schema cache hits
still diagnose failures at query time; no extra probe is made on every read.

`stats.history.provenance` is restricted to queried tables. It adds `historyId`,
`revision`, `state` (`active`, `retained`, `unknown`) and `retiredAt`. State is a
controller-ledger registration state, not evidence that the publisher is currently
running or the table contains measurements in the requested window. A legacy row
without a history id stays `unknown`. Explicit reads report matching provenance
when available. Registry resolution uses the existing bounded cache (60s TTL);
metadata can describe the last valid snapshot during a controller outage.

Successful raw tuples, columns, limits and sampled/raw query policy are unchanged.
