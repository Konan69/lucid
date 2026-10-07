PostgreSQL port and round-trip report — 7 October 2026

Branch: `feat/pi-durable-pg`. The final benchmark and executable checks use implementation commit `5ac2c192`; the delivery message gives the final report commit and head SHA. No push, merge, deployment or pull request.

Commits, in order:

- `b6ece983`: PostgreSQL storage adapter, migrations, driver, conformance, run tests and benchmark.
- `5b0c7ab3`: orchestrator's restart checkpoint, preserved without amendment, squash or revert.
- `733c6a5a`: ordered write batches and single-statement snapshot reads; removes the temporary baseline copy from the checkpoint.
- `a665c482`: final write segment and COMMIT share one driver call.
- `d4502d9e`: previous measurements and port report.
- `dd23b8f2`: UTF8 connection guard, typed raw-NUL refusal and adversarial round trips.
- `195930e5`: scoped entry ancestry stays TEXT, following Pi's JavaScript walk.
- `5ac2c192`: nonblocking schema ownership before migrations and ownership tests.

Only the lane's owned PostgreSQL paths, optional-driver package/lock entries and exact Effect allowlist entries changed. README, frontend, other durable modules, application database schema and reference checkout remain untouched.

**Measurements**

Real PostgreSQL 18 Alpine in disposable container `durable-pg-lane`, loopback port 55449. SQLite is Pi's unchanged `openNodeSqliteStorage(':memory:')`. Smallest upstream scale: 1,000 entries, 200 tasks and 200 documents. Each benchmark operation runs once per backend per measurement; expected benchmark results are checked. No timing threshold.

The pre-batching baseline was measured with the original committed adapter. The temporary baseline source was removed after measurement. A benchmark-only wrapper around the real facade counts actual query-call boundaries: every SQL method is one driver call, ordinary successful transactions add BEGIN/COMMIT, and batched transactions add the initial BEGIN/read call and final writes/COMMIT call. Fixture initialization and cleanup are excluded. No fake driver or product-path counter.

Load averages from `uptime`, compared with `nproc = 16`:

- Baseline start: **1.79 / 1.54 / 1.64**.
- Previous benchmark start/completion: **28.91 / 17.23 / 11.41**, then **17.59 / 16.31 / 11.66** (historical measurements in `d4502d9e`).
- Final review-fix benchmark start, 15:58:17: **5.42 / 6.27 / 12.58**; 9 GB available memory, 4 GB swap used; one external Node process.
- Final review-fix benchmark completion, 15:58:41: **5.04 / 6.14 / 12.37**; 9 GB available memory, 4 GB swap used.

The current measurement ran below the core count. Machine load and memory conditions still differ between measurements; these are measured milliseconds, not a controlled latency comparison or a production throughput claim. Query counts are deterministic. SQLite has no network driver calls; its timings remain useful as the requested in-memory baseline.

| Write workload                            | PG calls before | PG ms before | PG calls after | PG ms after | SQLite ms before | SQLite ms after |
| ----------------------------------------- | --------------: | -----------: | -------------: | ----------: | ---------------: | --------------: |
| One entry                                 |               7 |        7.223 |              2 |       2.630 |            0.081 |           0.053 |
| 100 entries                               |             304 |      278.530 |              2 |      14.629 |            1.330 |           1.161 |
| Mixed entry/task/submission/document      |              20 |       19.318 |              6 |       9.106 |            0.446 |           0.418 |
| Streaming entry append                    |               7 |        6.807 |              2 |       2.303 |            0.045 |           0.081 |
| Streaming task update + document revision |              12 |       11.102 |              8 |       6.746 |            0.197 |           0.145 |
| Streaming submission + entry              |              10 |        8.085 |              2 |       2.590 |            0.066 |           0.047 |

| Read workload               | PG calls before | PG ms before | PG calls after | PG ms after | SQLite ms before | SQLite ms after |
| --------------------------- | --------------: | -----------: | -------------: | ----------: | ---------------: | --------------: |
| Seed 1k (includes writes)   |           18205 |    11173.897 |          10367 |    8693.141 |           78.485 |          78.478 |
| Exact entry                 |               1 |        2.160 |              1 |       1.338 |            0.321 |           0.260 |
| Entry page (100)            |               2 |        4.256 |              2 |       2.805 |            0.544 |           0.424 |
| Filtered tasks (50)         |               1 |        1.723 |              1 |       2.000 |            0.192 |           0.153 |
| Exact document address      |               1 |        1.330 |              1 |       1.008 |            0.100 |           0.084 |
| Document replay tail 0      |               5 |        5.810 |              1 |       2.317 |            0.295 |           0.458 |
| Document replay tail 16     |               5 |        6.923 |              1 |       2.435 |            0.189 |           0.173 |
| Document replay tail 128    |               5 |        7.620 |              1 |       3.197 |            0.810 |           0.657 |
| Document replay tail 1024   |               5 |       22.759 |              1 |      12.184 |            4.080 |           3.040 |
| Ancient historical document |               5 |        5.423 |              1 |       2.814 |            0.522 |           0.387 |
| Recent historical document  |               5 |        6.191 |              1 |       2.763 |            0.489 |           0.319 |
| Fork-depth history (100)    |               8 |        8.251 |              8 |       6.631 |            2.219 |           0.314 |
| Fork-depth head             |              18 |       15.681 |             18 |      14.047 |            1.748 |           0.223 |

**Port differences and reasons**

Reference paths below are relative to Pi's durable package. Every ported implementation has its file/symbol reference in JSDoc.

- `database.ts`, guided by `src/storage/sqlite/database.ts:SqliteExecutor/SqliteDatabase`: `get` returns plain `Option<T>` rather than `T | undefined`, as ruled by the orchestrator. The Storage implementation infers Pi's types and converts at its boundary. No Effect runtime enters the adapter.
- The owned facade adds `PostgresStatement`, `PostgresCommit`, `runBatch` and `transactionWithReads`. PostgreSQL cannot bind multiple statements through its extended protocol. The driver uses public `pg.escapeLiteral` for ordered simple-protocol batches, including lossless bigint text and byte-array hex. Prepared final segments are acknowledged only after COMMIT succeeds.
- `pg.ts`, guided by `src/storage/sqlite/node.ts:NodeSqliteExecutor/NodeSqliteDatabase/openNodeSqliteStorage`: `?` bindings become `$n` for ordinary queries. Batched bindings become safely quoted literals on a verified UTF8 connection. The opener reads client_encoding and standard_conforming_strings once on its lease; a non-UTF8 setting is refused with ConnectionSettingInvalid naming the setting/value. Both on/off string modes remain supported without changing host settings. RawNul rejects raw NUL before a complete batch reaches SQL text, naming the originating record kind; JSON-escaped NUL, lone surrogates and BYTEA zero bytes remain lossless. The facade retains recordKind alongside each owned statement for that diagnostic. SQLite's prepared-statement cache is not transplanted onto a leased pooled connection; queries remain unnamed.
- A supplied Pool owns connections and configuration. The opener leases one connection, validates the required ASCII schema identifier before any SQL, restricts search_path, restores its previous value on close and releases the lease. It never constructs or ends the host Pool. Unlike Pi's unenforced one-owner rule, it takes a nonblocking session advisory lock before migrations and refuses competing leases with StorageOwned naming the schema. The database-scoped signed 64-bit key is the first eight SHA256 bytes of UTF8 "@vivid/durable/postgres:" plus the exact schema, interpreted as big-endian signed bigint text. It is stable across upgrades; a hash collision conservatively refuses an owner. close explicitly unlocks before returning the connection; PostgreSQL releases the lock on backend/process death. Initialization failure destroys the lease and any acquired lock. File creation, WAL/checkpoint and busy-timeout settings have no PostgreSQL equivalent here.
- `migrations.ts`, guided by `src/storage/sqlite/migrations.ts`: schema creation and the schema-local migration ledger are transactional. Versions remain contiguous from 1, second open is a no-op, and newer databases are refused. PostgreSQL BIGINT replaces SQLite's 64-bit INTEGER for ids, sequences and document versions; flags remain INTEGER. Metadata next_id is BIGINT rather than SQLite TEXT.
- SQLite STRICT and `json_valid` become PostgreSQL column types and SQL/JSON `IS JSON` checks. JSON record/content columns remain TEXT. Indexed identity strings retain Pi's existing JSON-string encoding and use C collation for SQLite's bytewise comparison semantics. No JSONB conversion is introduced.
- SQLite INSERT OR IGNORE becomes ON CONFLICT DO NOTHING; task/submission replacement uses PostgreSQL ON CONFLICT DO UPDATE. Tables, extracted columns and indexes retain the reference structure and filtering/paging rules.
- `storage.ts`, guided by `src/storage/sqlite/storage.ts:SqliteStorage`: BIGINT driver values stay decimal text until checked conversion to Pi's numeric brands. Volatile id allocation uses bigint to retain the exhausted sentinel. Per-query text/binary INT8 parsers override a host's lossy global parser without changing it. Driver/backend-specific error names identify PostgreSQL; shared ownership, document and cursor rejection messages retain the reference behavior.
- Synchronous Schema codecs replace unchecked JSON ingress and runtime brand casts where repository rules require validation. Envelopes preserve extension fields and JSON text. Pure selections and comparisons are extracted to meet complexity limits. Node EventEmitter settlement replaces a raw Promise constructor for the admitted-read close barrier.
- PostgreSQL REPEATABLE READ replaces BEGIN IMMEDIATE for conditional commit/copy reads. Transaction callbacks still serialize unrelated work; settled handles reject. Callback/native/COMMIT failure rolls back before release, retaining the primary error; rollback failure remains AggregateError.
- Allocation/preflight: BEGIN, metadata SELECT and the ordered ownership SELECTs share one driver call. JavaScript comparisons still run metadata first, then ownership checks in write order, before any writes. Later read-only ownership lookups can be prefetched before an earlier JavaScript rejection; they introduce no write effects.
- Writes retain each individual claim, insert, upsert, delete and update in its reference position. Contiguous segments share a driver call. The final segment and COMMIT share a call; failed SQL stops subsequent statements and invokes rollback. Metadata remains last, sequence allocation remains inside the transaction, and the volatile watermark advances only after success.
- Multi-row INSERT was rejected because it reorders interleaved claims/writes and PostgreSQL cannot upsert a repeated mutable id twice in one INSERT. Installed pg 8.23.0 `lib/client.js:_pulsePipelinedQueryQueue` supports constructor-level pipelining; `pg-pool/index.js:newClient` forwards host options. There is no per-query pipeline switch. The adapter uses supported simple-protocol batching without recreating the host Pool or changing driver internals. CTEs cannot contain BEGIN/COMMIT; data-modifying CTEs share a snapshot and cannot preserve the general ordered delete/insert/upsert effects.
- Two calls are the minimum for the table-only path while retaining JavaScript validation before writes: one allocation/validation response and one durable commit response. Document writes retain conditional existence/version/address reads and the later record/copy read barriers. The measured mixed-create path is six calls; task update plus document revision is eight. These remaining reads are not moved across Pi's validation/copy/native-write error boundaries.
- The standalone benchmark uses Effect Config/Redacted only at its CLI entry. The optional pg entry and optional peer/dev dependencies keep core consumers independent of the driver. Promise methods and functions have exact third-party-adapter allowlist entries.

**Exact lookup behavior**

Six global exact lookup forms take one call. Scoped entry follows the reference ancestry walk and takes two calls plus one per visited parent. None needs an explicit read transaction:

- Global entry: one indexed immutable row.
- Scoped entry: read the requested conversation TEXT, then the entry TEXT, then each required parent TEXT in Pi's order, carrying the minimum inclusive fork cutoff. Unknown requested conversations retain their error. Session guarantees valid acyclic ancestry. PostgreSQL json extraction de-escapes the entire conversation record and rejects escaped NUL/lone surrogates; replacing the recursive SQL query with Pi's walk avoids that conversion without a schema migration. The regression includes both characters in root and child extensions, checks exact conversation round trips, and verifies the child lookup takes three calls. The global entry overload stays one call.
- Task: one current replacement row.
- Submission: one current receipt row.
- Submission by request: one conversation/request indexed lookup.
- Find document: one indexed address/lifetime lookup.
- Document: one lateral newest-base lookup and ordered delta aggregate. One PostgreSQL statement supplies the same snapshot Pi protected with three reads in a transaction. Only envelope fields are constructed as JSON; persisted record/content TEXT remains unparsed by PostgreSQL. BIGINT envelope fields are strings. Lifetime/current-only/base/version checks and Chord replay retain their original order.

**Verification commands and results**

`VIVID_TEST_DATABASE_URL` denotes only the disposable database on port 55449; no credentials or URL are recorded here. Package commands run from `packages/agent/durable`; lint/audit/version/format commands run from the repository root. Every Vitest invocation uses two workers and serial files, with no concurrent test/typecheck.

| Command                                                                                                                                                | Final result                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIVID_TEST_DATABASE_URL=<disposable-url> pnpm exec vitest run src/postgres --maxWorkers=2 --no-file-parallelism`                                      | 6 files, 48 tests passed; **23/23 upstream conformance**, unmodified, none skipped. Migration, rollback, driver and both end-to-end reopen/approval cases pass. |
| `VIVID_TEST_DATABASE_URL=<disposable-url> DURABLE_LIVE=0 pnpm exec vitest run --maxWorkers=2 --no-file-parallelism`                                    | 35 files passed, 1 skipped; **284 passed, 1 existing expected failure, 2 live tests skipped**.                                                                  |
| `env -u VIVID_TEST_DATABASE_URL DURABLE_LIVE=0 pnpm exec vitest run --maxWorkers=2 --no-file-parallelism`                                              | 29 files passed, 7 skipped; **236 passed, 1 existing expected failure, 50 skipped** including all 48 PostgreSQL tests.                                          |
| `pnpm typecheck`                                                                                                                                       | Passed.                                                                                                                                                         |
| `pnpm exec oxlint --type-aware packages/agent/durable/src/postgres`                                                                                    | 0 errors, 0 warnings.                                                                                                                                           |
| `pnpm audit:effect-boundaries`                                                                                                                         | 408 files, 336 findings; 0 unallowlisted, no stale or duplicate entries.                                                                                        |
| `pnpm check:versions`                                                                                                                                  | Passed.                                                                                                                                                         |
| `pnpm exec oxfmt --check packages/agent/durable scripts/effect-boundary-allowlist.json`                                                                | Passed.                                                                                                                                                         |
| `git diff --check`                                                                                                                                     | Passed.                                                                                                                                                         |
| `VIVID_TEST_DATABASE_URL=<disposable-url> VIVID_DURABLE_POSTGRES_BENCHMARK=1 pnpm exec node --experimental-transform-types src/postgres/bench/main.ts` | Passed; smallest-scale tables above, PostgreSQL and SQLite expected results verified.                                                                           |
| `pnpm exec node --experimental-transform-types packages/agent/durable/src/postgres/bench/main.ts`                                                      | Benchmark skipped by default, exit 0.                                                                                                                           |

Focused review checks: literal safety 5/5; storage plus round-trip tests 28/28; ownership plus migration tests 13/13. Initial SJIS setup used Pool options, which pg's getStartupConf overrides to UTF8; the final test sets SJIS on a real lease before opening. A refused lease is destroyed, so the subsequent Pool query proves usability rather than expecting that dead lease's encoding. The review's indexed-text probe records were made valid for Pi 1.0.4 (pending checkpoint and fork=asOf); all adversarial strings are unchanged. Typecheck caught those fixture-shape errors and they were corrected. No rule or conformance case was disabled or weakened. Final checks pass.

The withdrawn lock_timeout finding was not implemented. Ownership is acquired before schema SQL instead: a concurrent fresh-schema test proves exactly one successful open and one typed StorageOwned, with no raw 23505. No host lock or durability setting is changed. The inherited expected failure and live skips were not changed. No timeout was raised and no sleep or polling was added.

**README lines to add — README was not edited**

> PostgreSQL storage is available from `@vivid/durable/postgres`. Pass a host-owned `pg` Pool and a required schema identifier to `openPgStorage(pool, schema)`, then supply that storage to your Pi Harness. PostgreSQL 16 or newer is required; this adapter was tested against PostgreSQL 18. Records and tool output remain JSON text. The leased connection must use UTF8; both standard_conforming_strings modes are supported and host settings are not silently changed. Closing storage releases its connection and does not end the host's pool. One connection owns a schema at a time, enforced with a nonblocking session advisory lock acquired before migrations. A competing opener receives StorageOwned naming the schema. Ownership is released on close or backend/process death; open again after the previous owner has closed.

```ts
import { openPgStorage } from '@vivid/durable/postgres'

const storage = await openPgStorage(pool, 'durable')
```

**Limits and cleanup**

No production/app database, remote host, live provider, separate Node-process ownership race, alternate driver, PostgreSQL 16/17, remote-network latency or sustained streaming throughput was tested. No repository-wide gate or typecheck was run for this revision. The host-supplied pg adapter, real local PostgreSQL conformance, separate-backend ownership/termination, and faux-provider Harness reopen/approval were proved. A separate operating-system process death was not exercised; PostgreSQL backend termination was. No frontend work was performed.

All schema fixtures register cleanup before migration writes. PostgreSQL catalog checks found **0 remaining lane schemas and 0 advisory locks**. Only the container started by this lane was removed with `docker rm -f durable-pg-lane`.

Additional focused commands and cleanup:

| Command                                                                                                                                                             | Result                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `VIVID_TEST_DATABASE_URL=<disposable-url> pnpm exec vitest run src/postgres/quoting.test.ts --maxWorkers=2 --no-file-parallelism`                                   | 5 passed.                                                                                                         |
| `VIVID_TEST_DATABASE_URL=<disposable-url> pnpm exec vitest run src/postgres/trips.test.ts src/postgres/storage.test.ts --maxWorkers=2 --no-file-parallelism`        | 28 passed, including all 23 upstream cases.                                                                       |
| `VIVID_TEST_DATABASE_URL=<disposable-url> pnpm exec vitest run src/postgres/ownership.test.ts src/postgres/migrations.test.ts --maxWorkers=2 --no-file-parallelism` | 13 passed.                                                                                                        |
| `docker exec durable-pg-lane pg_isready -U vivid -d vivid_test`                                                                                                     | Accepting connections.                                                                                            |
| `docker exec durable-pg-lane psql -U vivid -d vivid_test` (catalog queries)                                                                                         | No lane schemas or advisory locks remain.                                                                         |
| `docker rm -f durable-pg-lane`                                                                                                                                      | Removed only this lane's disposable container.                                                                    |
| `git status --short` and explicit-path commits                                                                                                                      | Clean checkout; all revision changes are in the owned PostgreSQL paths and the exact owned async allowlist entry. |

**Round 11: large-entry storage — 7 October 2026**

The adapter now reproduces pg 8.23.0 `lib/utils.js:escapeLiteral` with a native replacement and flat join, rather than retaining one rope node per input character. Twelve cases prove exact formatter equality; the real PostgreSQL tests prove both standard_conforming_strings modes. UTF8 and raw-NUL guards still apply. No statement order or transaction boundary changes.

One entry was measured per size in a child with `--max-old-space-size=1024`, against disposable PostgreSQL 18. Each child committed and read back equal, then closed its storage and Pool. Values are MiB (1024² bytes), RSS is MiB, and milliseconds per MB below use that same unit. A test-only async hook measures the longest synchronous callback; it imposes no timing assertion and uses no polling or sleeps.

| Entry size | Commit ms | Commit ms/MB | Read ms | Read ms/MB | Peak RSS MB | Longest callback ms |
| ---------- | --------: | -----------: | ------: | ---------: | ----------: | ------------------: |
| 16 MB      |   365.388 |       22.837 | 174.278 |     10.892 |     279.711 |              37.365 |
| 64 MB      |  1458.327 |       22.786 | 737.786 |     11.528 |     525.797 |             188.109 |

The 64 MB callback stall was below about one second, so no large-value bound-parameter threshold was added. Commit wall time includes PostgreSQL and transport waits; it is not a synchronous event-loop stall. Multiple simultaneous large entries and V8's maximum joined-string size remain untested; these numbers are not a general size guarantee. The original formatter's linear heap amplification is removed.
