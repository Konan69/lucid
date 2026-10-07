PostgreSQL port and round-trip report — 7 October 2026

Latest Turn 6 status: Part A (`8f8c9190`) and Part B (`37a2cca0`) are complete; 134 owned Effect findings became zero. Package tests pass with and without PostgreSQL. Build and packed-package verification are blocked by unowned `src/holds.ts:459:14` TS2883; the tools lane must annotate readerDecision. The newest results and blocker are in the final Turn 6 section; earlier tables are historical. The delivery message provides the report/head SHA.

Branch: `feat/pi-durable-pg`. The first sections preserve the Round 10 measurements and checks at `5ac2c192`. Round 11 results and decisions follow below, based on merged head `f77167f0`; the delivery message gives the final report commit and head SHA. No push, merge, deployment or pull request.

Commits, in order:

- `b6ece983`: PostgreSQL storage adapter, migrations, driver, conformance, run tests and benchmark.
- `5b0c7ab3`: orchestrator's restart checkpoint, preserved without amendment, squash or revert.
- `733c6a5a`: ordered write batches and single-statement snapshot reads; removes the temporary baseline copy from the checkpoint.
- `a665c482`: final write segment and COMMIT share one driver call.
- `d4502d9e`: previous measurements and port report.
- `dd23b8f2`: UTF8 connection guard, typed raw-NUL refusal and adversarial round trips.
- `195930e5`: scoped entry ancestry stays TEXT, following Pi's JavaScript walk.
- `5ac2c192`: nonblocking schema ownership before migrations and ownership tests.

Round 10 changed only the lane's owned PostgreSQL paths, optional-driver package/lock entries and exact Effect allowlist entries. Round 11 additionally owns the example host, source-entry test, build configuration and the two README sections specified by the orchestrator. Frontend, other durable modules, application database schema and reference checkout remain untouched.

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
- The owned facade adds `PostgresStatement`, `PostgresCommit`, `runBatch` and `transactionWithReads`. PostgreSQL cannot bind multiple statements through its extended protocol. Round 10 used public `pg.escapeLiteral` for ordered simple-protocol batches, including lossless bigint text and byte-array hex; Round 11 replaces its heap-heavy implementation with an exactly equivalent flat formatter. Prepared final segments are acknowledged only after COMMIT succeeds.
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

**Round 10 proposed README text — incorporated and extended in Round 11**

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
| 16 MB      |   355.643 |       22.228 | 183.319 |     11.457 |     279.926 |              37.571 |
| 64 MB      |  1430.352 |       22.349 | 759.010 |     11.860 |     525.617 |             153.737 |

The 64 MB callback stall was below about one second, so no large-value bound-parameter threshold was added. Commit wall time includes PostgreSQL and transport waits; it is not a synchronous event-loop stall. Multiple simultaneous large entries and V8's maximum joined-string size remain untested; these numbers are not a general size guarantee. The original formatter's linear heap amplification is removed.

Final size measurement: `uptime` at 19:10:24 reported **2.00 / 1.72 / 1.82** against **16 cores**; 11 GB available memory, 7 GB swap used, one external Node process. The database was PostgreSQL 18 in this lane's disposable `durable-pg-round11-pg`, with an automatically allocated loopback port (44622). No other container or database was used.

**Round 11 commits and decisions**

- `13f23e8e` — PK1: explicit fields and constructor assignments replace TypeScript parameter properties in PostgreSQL code, so plain Node can erase types. One child imports all four source entries with no transpilation flags. The build config enables erasableSyntaxOnly. The package-wide option was tried but remains off under the ruling: unowned `src/fixtures/chat.ts:8:15` uses a parameter property and produces TS1294. No other lane's file was edited.
- `c91006dd` — PG1: native replacement doubles quotes/backslashes in one linear pass and a flat join reproduces pg 8.23.0 escapeLiteral, including its E-string prefix. Twelve awkward cases compare exact output to the installed driver's formatter; existing real UTF8 tests retain both standard_conforming_strings settings. Child tests at 16 and 64 MiB cap the heap at 1024 MiB and assert exit 0 and equality, without a timing assertion. A test-only async hook measures synchronous callback spans without polling. No size threshold was added because the measured longest callback at 64 MiB was 153.737 ms; wall-clock commit time includes IO. Transaction order, allocation and driver-call counts are unchanged.
- `20f2226c` — PG2: StorageDisconnected is exported with schema and the original driver error as cause. The leased connection's public error listener caches that error; every storage operation, including mintId, checks the same cached health state. No reconnection occurs. The storage boundary maps dead-connection commit failures to this tag while the facade retains Pi's rollback-failure AggregateError rules. Backend termination proves every public call is fenced and a real close/reopen works.
- `a1659bcd` — PG3/PG4/RD2: RawNul.recordKind is one authoritative closed Schema literal union, consumed by the facade. Ordinary Storage values are JSON encoded, so raw NUL cannot reach SQL through those records; the facade guard remains for raw bindings. The README explains the lifetime pool lease, pool sizing and connectionTimeoutMillis, session ownership, and direct/session pooling. A real exhausted one-slot pool proves bounded acquisition failure and lease recovery. Transaction-mode pooling was not run and is explicitly unsupported for this session-based adapter.
- `81e5bdcd` — EX1: restores one Promise entry import from @vivid/durable and direct Promise HTTP routes. Effect still owns the example's resource lifetime; its registry uses a narrow classified Effect.tryPromise for the third-party Promise API. Failure after disconnect logs one fixed line without the error object; intentional pipe cancellation remains silent. Resume documents Pi's idempotent pending-work contract and runs before listening. The denial branch, work steps and harness.resume() from head remain.
- `c8c36ccf` — EX2: calls the public decodeTurn before conversation creation or mapping writes. The compiled JSON/envelope decoders remain at ingress. Stricter TCP tests prove malformed messages, empty turns and invalid roles return 400 and leave history at 404 for a fresh id. Both example entry points include Allow on 405 responses.
- `63706a46` — RD1: the owned Runnable example section now says approve requests approval, ask requests a person-supplied output, and pay echoes. Real TCP tests prove pay produces an echo without a tool part and the existing approval scenario still passes. The remaining section was checked against the host: routes, history query arguments, reconnect helper, HOST/PORT, retained/temporary directory, startup resume, signals and CORS match it.
- `4e81678f` — final verification corrections: use the public typed Node EventEmitter.once form and Pi EntryRecord.data in the bounded-heap child; add the exact registry allowlist classification. These changes correct test types and boundary bookkeeping, not storage semantics. The final focused tests re-ran those files.

Every added async adapter symbol has an exact allowlist entry. No lint rule, timeout, conformance case or expected failure was weakened. No product/UI code was changed. The only ruling partially deferred is the package-wide erasableSyntaxOnly option due to the unowned fixture above; the build guard and plain Node entry proof pass.

**Round 11 commands and results**

Package commands run from packages/agent/durable; lint, audit, versions and formatting run from the root. All commands ran serially, with Vitest limited to two workers and serial files. VIVID_TEST_DATABASE_URL referred only to the disposable database. DURABLE_LIVE=0 prevents provider calls. The existing 30 s test failure bound was not changed.

| Command                                                                                                                                                  | Result                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git status --short`; `git log --oneline -5`                                                                                                             | Inspected baseline f77167f0 and owned changes; no history rewritten.                                                                                                                                                                                   |
| `VIVID_TEST_DATABASE_URL=<disposable-url> pnpm exec vitest run src/postgres src/entries.test.ts --maxWorkers=2 --no-file-parallelism --reporter=verbose` | Final proof: **9 files, 65 passed**; 64 PostgreSQL/formatter tests plus one four-entry import proof. **23/23 upstream conformance**, unchanged. All 52 database tests pass; 12 pure formatter cases pass. Large-entry stdout supplies the table above. |
| `VIVID_TEST_DATABASE_URL=<disposable-url> DURABLE_LIVE=0 pnpm exec vitest run --maxWorkers=2 --no-file-parallelism`                                      | **69 files passed, 1 skipped; 634 passed, 1 unchanged expected failure, 2 live tests skipped** (637 total).                                                                                                                                            |
| `env -u VIVID_TEST_DATABASE_URL DURABLE_LIVE=0 pnpm exec vitest run --maxWorkers=2 --no-file-parallelism`                                                | **62 files passed, 8 skipped; 582 passed, 1 unchanged expected failure, 54 skipped** (52 database + 2 live). Formatter and plain Node tests still run.                                                                                                 |
| `pnpm exec vitest run src/examples --maxWorkers=2 --no-file-parallelism` and subsequent focused serve tests                                              | Restored host: 13 passed; stricter validation: 12 serve cases passed; final whole-package run includes the added pay scenario (13 serve cases plus one entry audit).                                                                                   |
| `pnpm typecheck`                                                                                                                                         | Exit **0**; no ordinary TypeScript errors. Prints **609 Effect errors, 4 warnings, 39 suggestions** under the inherited root ignoreEffectErrors/Warnings/SuggestionsInTscExitCode policy. This is not a diagnostic-clean claim. No policy was changed. |
| `pnpm build`                                                                                                                                             | Exit **0**; native TypeScript emits the distributable with erasableSyntaxOnly enabled. Also prints inherited nonfatal Effect diagnostics.                                                                                                              |
| `pnpm check:package`                                                                                                                                     | Exit **0**; packed consumers pass native and classic TypeScript checks under bundler and NodeNext resolution; faux-provider streaming consumer passes.                                                                                                 |
| `pnpm exec oxlint --type-aware packages/agent/durable/src`                                                                                               | Exit **0**, no errors or warnings.                                                                                                                                                                                                                     |
| `pnpm audit:effect-boundaries`                                                                                                                           | **422 files; 426 findings; 0 unallowlisted**; no stale or duplicate entry.                                                                                                                                                                             |
| `pnpm check:versions`                                                                                                                                    | Passed.                                                                                                                                                                                                                                                |
| `pnpm exec oxfmt --check packages/agent/durable scripts/effect-boundary-allowlist.json`                                                                  | Passed.                                                                                                                                                                                                                                                |
| `git diff --check`                                                                                                                                       | Passed.                                                                                                                                                                                                                                                |
| `docker exec durable-pg-round11-pg psql -U vivid -d vivid_test` (catalog checks)                                                                         | **0 remaining durable test schemas, 0 advisory locks**.                                                                                                                                                                                                |
| `docker rm -f durable-pg-round11-pg`                                                                                                                     | Removed only the container started for this round.                                                                                                                                                                                                     |

Initial focused checks also passed: plain Node entry (1), formatter/UTF8/bounded heap (19), ownership/migrations (14), disconnected storage (5), then ownership/quoting after pool exhaustion (11). The initial ordinary TypeScript failures in the added tests were fixed; the package-wide erasability finding is left to its owning lane. The full package run preceded the final test-only typing corrections, which the 65-case focused proof then verified. The full smallest-scale PostgreSQL/SQLite benchmark was not repeated this round; the retained Round 10 comparison above remains its result. The final trips test still measures 2 calls for one entry/100 entries/submission+entry, 6 for mixed creation and 8 for task update plus document revision.

**Round 11 README text**

Only PostgreSQL storage and Runnable example were edited. They now explain the pool lease and bounded pool acquisition, direct/session pooling requirement (transaction-mode pooling not run), StorageDisconnected recovery (close it, then reopen storage and Harness), the measured 64 MiB entry limits, RawNul's facade boundary, and the approve/ask/pay example triggers. The proposed Round 10 opener snippet above remains valid.

**Round 11 limits**

No live provider, frontend, app database, SSH, remote host, push, merge, deployment or pull request. No root gate or whole-repository typecheck. PostgreSQL 16/17, transaction-mode poolers, Node 22, remote-network latency, sustained throughput, concurrent large entries, V8 maximum string sizes and mid-commit backend death were not checked. Tests used Node 24, PostgreSQL 18, real leased connections and the faux provider. Package-wide erasableSyntaxOnly remains deferred as allowed by PK1; emitted/source entry points have the build guard and plain Node proof. Compiler exit 0 follows the existing shared policy for advisory Effect diagnostics; those diagnostics have not been suppressed or fixed in other lanes.

**Turn 6: waiting refusal and owned Effect rules — 7 October 2026**

Baseline `24f3fb4b`, branch `feat/pi-durable-pg`. The final delivery gives the head/report commit. `8f8c9190` fixes Part A; `37a2cca0` fixes Part B. The final documentation commit records the results and explains finite numeric envelopes beside the port. Only assigned files and exact allowlist entries changed; no other lane's file, compiler policy, dependency, frontend component, styling or hook implementation changed. The React test's stock Probe syntax and JSX are unchanged; only its async test orchestration changed.

Part A: both Promise and Effect examples explicitly map TurnWaiting to HTTP 409. Two new cases in serve.test.ts check the exact typed refusal text, retain the original approval identity, and approve successfully afterwards. One uses real TCP and the runnable host; the other calls the Effect example with the real Pi/faux-provider fixture. Removing the Effect mapping makes the latter fail with TurnWaiting; restoring it makes both pass. TurnStranded belongs to followRun, which this example does not expose, as its one comment states. The Runnable example README now explains the 409.

Part B decisions:

- **134 owned Effect findings became zero**: 107 asyncFunction, 24 schemaNumber, one multipleCatchTag, one globalErrorInEffectFailure and one unnecessaryEffectGen. No casts, widened error channels, removed assertions or file-level switches were used. The final package graph still prints **559 findings outside these owned paths**; its inherited nonfatal policy was not changed. A strict whole-package verdict requires the other lanes' changes.
- Pi's Storage port stays Promise-native. The **25 storage.ts and two pg.ts next-line asyncFunction directives** name the Storage Promise contract and the actual SQLite reference method or branch (readScopedEntry cites readEntry's ancestry branch; checkDelta cites checkDocumentActions). Allocation, SQL order, transaction boundaries and driver calls are unchanged. Every boundary still has an exact audit entry. No new Effect runtime enters storage or its driver.
- Numeric database envelopes, Chord offsets, token counts and example/benchmark numeric ingress use Finite/FiniteFromString. These are finite domain values: SQL ids/versions are integers, JSON cannot persist NaN/infinity as numbers, and token counts/body limits/ports cannot be nonfinite. BIGINT stays decimal text until checked conversion; persisted JSON payloads remain TEXT. The finite-envelope reason is also stated beside the code.
- The owned migration runner uses non-async Promise chaining at the facade boundary. It retains contiguous-version validation as a rejection, the same transaction, and the original statement/version-update order. No extra driver call is introduced. The example's Promise ingress likewise uses direct Promise functions and chains; the Effect example remains an Effect program, with one catchTags map. Iterator cleanup retains the original body failure and the incoming socket's destroyOnReturn:false rule. The fixed after-disconnect log remains unchanged.
- Our tests use @effect/vitest and Effect.gen, with live mode for real database/TCP/React/child-process IO and pure Effect.sync for literal equality. Every original name, assertion count and observable step remains. Promise APIs enter through Effect.promise; expected rejections enter through Effect.tryPromise with a typed observation that retains the original cause and throw semantics. SDK/transaction/cleanup callbacks return plain Promises where their contract requires them. Test resources are still registered before writes; additional standalone-facade cleanup handles failed Effect cases.
- Pi's published registerStorageConformance is still called with Vitest's actual describe/expect/it and a Promise fixture callback. The upstream runner registers its unchanged 23 Promise cases; it is not adapted to Effect. With a non-async fixture callback, asyncFunction reports **zero at our call site**; the published JavaScript suite is outside this TypeScript diagnostic graph.
- The requested `git grep -l "it.effect\|it.live" origin/main -- 'apps/web/src/**/*.test.tsx'` found no converted React test. Both web test files on the available origin/main are synchronous. The conversion follows main's desktop signin.test.ts Effect-test/resource shape and the stock React act Promise seam. No UI, component, markup, copy or stock useChat behavior was redesigned; all three hook cases pass.
- Benchmark orchestration now returns Effects. Only each CLI's module entry runs an Effect runtime. Scopes release storage before the pool, and remove fresh schemas even when initialization fails. The existing test-only query counter remains outside the product path. The full smallest-scale benchmark was rerun to prove the changed CLI.

**Case/expectation preservation**

Counts use the requested source-case pattern `^\s*(it|test)[.(]` and `expect\(`. They count declarations, without expanding each tables. Before means after Part A and before Part B; Part A separately added two cases and nine assertions to serve.test.ts. Pi's 23 registered cases are counted by the real run, separately from source declarations.

| File                        | Cases before | Cases after | Expects before | Expects after |
| --------------------------- | -----------: | ----------: | -------------: | ------------: |
| examples/entry.test.ts      |            1 |           1 |              2 |             2 |
| examples/serve.test.ts      |            9 |           9 |             77 |            77 |
| postgres/large.test.ts      |            1 |           1 |              3 |             3 |
| postgres/literal.test.ts    |            1 |           1 |              1 |             1 |
| postgres/migrations.test.ts |            8 |           8 |             19 |            19 |
| postgres/ownership.test.ts  |            6 |           6 |             20 |            20 |
| postgres/quoting.test.ts    |            3 |           3 |             16 |            16 |
| postgres/run.test.ts        |            2 |           2 |             17 |            17 |
| postgres/storage.test.ts    |            3 |           3 |              9 |             9 |
| postgres/trips.test.ts      |            2 |           2 |              7 |             7 |
| react/chat.test.tsx         |            3 |           3 |              9 |             9 |

An AST check also found zero async function declarations/callbacks in all eleven owned test files, including React. No new fails/skip marker was added. The PostgreSQL describe.skipIf absence rule and the two existing live skips remain; focused -t selections below are temporary filters, not skipped conformance cases.

**Turn 6 benchmark**

Real PostgreSQL 18 in disposable durable-pg-round12-pg, random loopback port 44625; SQLite is Pi's unchanged :memory: opener. Smallest scale is 1,000 entries / 200 tasks / 200 documents. Each operation was measured once and its expected result verified. Start load at 20:37:30 was **3.29 / 2.29 / 1.87** against **16 cores**; completion/build start load was **2.40 / 2.22 / 1.88**, with 12 GB available and 3 GB swap used. No time threshold, no sleeps, no polling. These local milliseconds are observations, not production throughput claims.

**Read workloads**

| Workload                                  | PG calls |    PG ms | SQLite ms |
| ----------------------------------------- | -------: | -------: | --------: |
| seed 1k (1000/200/200)                    |    10367 | 7749.905 |    57.431 |
| exact entry lookup                        |        1 |    1.270 |     0.341 |
| entry page scan (100)                     |        2 |    3.231 |     0.427 |
| filtered task scan (50)                   |        1 |    1.271 |     0.154 |
| exact document address among many         |        1 |    0.875 |     0.081 |
| document replay tail (0)                  |        1 |    2.002 |     0.181 |
| document replay tail (16)                 |        1 |    2.655 |     0.126 |
| document replay tail (128)                |        1 |    3.657 |     0.504 |
| document replay tail (1024)               |        1 |   11.960 |     2.571 |
| ancient historical read before newer base |        1 |    2.565 |     0.284 |
| recent historical read after newer base   |        1 |    2.879 |     0.503 |
| fork-depth history scan (100)             |        8 |    6.521 |     0.893 |
| fork-depth head lookup                    |       18 |   11.122 |     0.207 |

**Write workloads**

| Workload                                    | PG calls |  PG ms | SQLite ms |
| ------------------------------------------- | -------: | -----: | --------: |
| commit one entry                            |        2 |  2.696 |     0.056 |
| commit 100 entries                          |        2 | 12.034 |     0.652 |
| commit mixed entry/task/submission/document |        6 |  7.638 |     0.375 |
| stream entry append                         |        2 |  1.876 |     0.030 |
| stream task update + document revision      |        8 |  5.999 |     0.229 |
| stream submission + entry                   |        2 |  2.125 |     0.069 |

The historical before/after call table above remains the baseline: one-entry commits retain **2 calls**, down from 7; 100 entries retain 2, down from 304. Scoped ancestry and document snapshot rules are unchanged. The repeated mutable-id case still proves ordered upserts rather than a reordered multi-row write.

The focused bounded-heap run at load **1.50 / 1.49 / 1.59 on 16 cores** also passed both child cases. With the converted Effect CLI, 16 MiB committed in **357.032 ms** (22.314 ms/MiB), read in 180.327 ms, peak RSS 275.875 MiB, longest callback 38.216 ms; 64 MiB committed in **1,627.426 ms** (25.429 ms/MiB), read in 744.100 ms, peak RSS 525.906 MiB, longest callback 161.268 ms. Equality and exit 0 remain the only test assertions, with the same 1024 MiB heap cap. The largest callback remains well below a second; no bound-parameter threshold was added.

**Turn 6 commands and results**

Package commands run from packages/agent/durable, root checks from the root. Every heavy command ran serially; Vitest always used maxWorkers=2 and serial files. VIVID_TEST_DATABASE_URL referred only to the lane's disposable database; DURABLE_LIVE=0 prevents provider calls.

| Command                                                                                                                              | Result                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git status --short`; `git log --oneline -5`                                                                                         | Clean baseline 24f3fb4b inspected.                                                                                                                                                           |
| `pnpm exec vitest run src/examples/serve.test.ts --maxWorkers=2 --no-file-parallelism -t 'waiting turn\|refuses a message'`          | **2 passed**. Removing the Effect mapping and selecting waiting turn gave **1 failed** with TurnWaiting, proving the regression; mapping restored before commit.                             |
| `pnpm exec vitest run src/examples src/react --maxWorkers=2 --no-file-parallelism`                                                   | **3 files, 19 passed** (15 serve, one source-entry audit, three stock-hook cases).                                                                                                           |
| `VIVID_TEST_DATABASE_URL=<disposable-url> pnpm exec vitest run src/postgres --maxWorkers=2 --no-file-parallelism --reporter=verbose` | **8 files, 64 passed; 23/23 upstream conformance**, unchanged and none skipped. Includes 52 database and 12 formatter cases.                                                                 |
| `VIVID_TEST_DATABASE_URL=<disposable-url> DURABLE_LIVE=0 pnpm exec vitest run --maxWorkers=2 --no-file-parallelism`                  | **71 files passed, 1 skipped; 671 passed, 1 unchanged expected failure, 2 live skipped** (674 total), 107.66 s.                                                                              |
| `env -u VIVID_TEST_DATABASE_URL DURABLE_LIVE=0 pnpm exec vitest run --maxWorkers=2 --no-file-parallelism`                            | **64 files passed, 8 skipped; 619 passed, 1 unchanged expected failure, 54 database/live skipped** (674 total), 99.55 s.                                                                     |
| `pnpm typecheck`                                                                                                                     | Exit **0**; **0 owned printed Effect findings**, **0 ordinary TypeScript errors**. The shared nonfatal policy still prints 559 Effect findings in unowned files. That policy was not edited. |
| `pnpm exec oxlint --type-aware packages/agent/durable/src`                                                                           | Exit **0**, **0 errors and 0 warnings**.                                                                                                                                                     |
| `pnpm audit:effect-boundaries`                                                                                                       | **422 files, 374 findings, 0 unallowlisted**; no stale or duplicate entry.                                                                                                                   |
| `pnpm exec oxfmt --check packages/agent/durable scripts/effect-boundary-allowlist.json`                                              | Passed.                                                                                                                                                                                      |
| `pnpm check:versions`; `git diff --check`                                                                                            | Passed.                                                                                                                                                                                      |
| `VIVID_TEST_DATABASE_URL=<disposable-url> VIVID_DURABLE_POSTGRES_BENCHMARK=1 pnpm exec node src/postgres/bench/main.ts`              | Exit **0**; both backend tables above, with expected results checked and resources released.                                                                                                 |
| `pnpm build`                                                                                                                         | **Failed, exit 1**: unowned src/holds.ts:459:14 TS2883 on exported readerDecision. No owned compiler finding.                                                                                |
| `pnpm check:package`                                                                                                                 | **Failed, exit 1** at its mandatory clean-build step, with the same TS2883. Packed consumer checks did not run; no stale dist was accepted.                                                  |
| `docker exec durable-pg-round12-pg pg_isready -U vivid -d vivid_test`                                                                | Accepting connections.                                                                                                                                                                       |
| `docker exec durable-pg-round12-pg psql -U vivid -d vivid_test` (catalog queries)                                                    | **0 remaining durable schemas, 0 advisory locks**.                                                                                                                                           |
| `docker rm -f durable-pg-round12-pg`                                                                                                 | Removed only the container this lane started.                                                                                                                                                |

The build blocker is exact:

```text
src/holds.ts(459,14): error TS2883: The inferred type of 'readerDecision' cannot be named without a reference to 'Harness' from '../node_modules/@earendil-works/pi-durable/dist/harness/types'. This is likely not portable. A type annotation is necessary.
```

The tools lane must supply a portable public type annotation for the exported readerDecision in src/holds.ts; it is explicitly outside this turn's owned paths. Build and packed-package checks must then be rerun. This lane did not bypass the build, edit a foreign file, disable a rule or weaken a case. **The full done state is blocked, not ready to merge.** Owned Part A/B fixes and focused/package tests are complete.

Not checked: a strict whole-package Effect verdict after the other lanes' integration, packaged consumers (blocked before packing), Node 22, PostgreSQL 16/17, alternate drivers, transaction-mode poolers, remote latency, live providers, sustained throughput, concurrent large records or frontend rendering. No root gate or root typecheck, SSH, push, merge, deployment, PR, credential-store or app-database access. The permitted stock-hook test ran headlessly in jsdom and kept the Probe's UI syntax unchanged.
