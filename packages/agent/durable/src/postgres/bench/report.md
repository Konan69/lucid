PostgreSQL port and round-trip report — 7 October 2026

Branch: `feat/pi-durable-pg`. Benchmark and final executable checks use implementation commit `a665c482`; the delivery message gives the final report commit and head SHA. No push, merge, deployment or pull request.

Commits, in order:

- `b6ece983`: PostgreSQL storage adapter, migrations, driver, conformance, run tests and benchmark.
- `5b0c7ab3`: orchestrator's restart checkpoint, preserved without amendment, squash or revert.
- `733c6a5a`: ordered write batches and single-statement snapshot reads; removes the temporary baseline copy from the checkpoint.
- `a665c482`: final write segment and COMMIT share one driver call.

Only the lane's owned PostgreSQL paths, optional-driver package/lock entries and exact Effect allowlist entries changed. README, frontend, other durable modules, application database schema and reference checkout remain untouched.

**Measurements**

Real PostgreSQL 18 Alpine in disposable container `durable-pg-lane`, loopback port 55449. SQLite is Pi's unchanged `openNodeSqliteStorage(':memory:')`. Smallest upstream scale: 1,000 entries, 200 tasks and 200 documents. Each benchmark operation runs once per backend per measurement; expected benchmark results are checked. No timing threshold.

The fresh baseline uses the original committed adapter. The temporary baseline source was removed after measurement. A benchmark-only wrapper around the real facade counts actual query-call boundaries: every SQL method is one driver call, ordinary successful transactions add BEGIN/COMMIT, and batched transactions add the initial BEGIN/read call and final writes/COMMIT call. Fixture initialization and cleanup are excluded. No fake driver or product-path counter.

Load averages from `uptime`, compared with `nproc = 16`:

- Baseline start: **1.79 / 1.54 / 1.64**.
- Final benchmark start: **28.91 / 17.23 / 11.41**; 2 GB available memory, 7 GB swap used.
- Final benchmark completion: **17.59 / 16.31 / 11.66**.

The machine became contended again. These are measured milliseconds, not a controlled latency comparison or a production throughput claim. Query counts are deterministic. SQLite has no network driver calls; its timings remain useful as the requested in-memory baseline.

| Write workload                            | PG calls before | PG ms before | PG calls after | PG ms after | SQLite ms before | SQLite ms after |
| ----------------------------------------- | --------------: | -----------: | -------------: | ----------: | ---------------: | --------------: |
| One entry                                 |               7 |        7.223 |              2 |       2.478 |            0.081 |           0.051 |
| 100 entries                               |             304 |      278.530 |              2 |      17.790 |            1.330 |           0.662 |
| Mixed entry/task/submission/document      |              20 |       19.318 |              6 |      10.632 |            0.446 |           0.299 |
| Streaming entry append                    |               7 |        6.807 |              2 |       2.594 |            0.045 |           0.025 |
| Streaming task update + document revision |              12 |       11.102 |              8 |       9.582 |            0.197 |           0.092 |
| Streaming submission + entry              |              10 |        8.085 |              2 |       2.368 |            0.066 |           0.038 |

| Read workload               | PG calls before | PG ms before | PG calls after | PG ms after | SQLite ms before | SQLite ms after |
| --------------------------- | --------------: | -----------: | -------------: | ----------: | ---------------: | --------------: |
| Seed 1k (includes writes)   |           18205 |    11173.897 |          10367 |   10306.991 |           78.485 |          70.137 |
| Exact entry                 |               1 |        2.160 |              1 |       1.513 |            0.321 |           0.257 |
| Entry page (100)            |               2 |        4.256 |              2 |       4.225 |            0.544 |           0.493 |
| Filtered tasks (50)         |               1 |        1.723 |              1 |       2.145 |            0.192 |           0.162 |
| Exact document address      |               1 |        1.330 |              1 |       1.136 |            0.100 |           0.079 |
| Document replay tail 0      |               5 |        5.810 |              1 |       5.564 |            0.295 |           0.202 |
| Document replay tail 16     |               5 |        6.923 |              1 |       2.642 |            0.189 |           0.153 |
| Document replay tail 128    |               5 |        7.620 |              1 |       5.391 |            0.810 |           0.605 |
| Document replay tail 1024   |               5 |       22.759 |              1 |      12.574 |            4.080 |           2.825 |
| Ancient historical document |               5 |        5.423 |              1 |       4.236 |            0.522 |           0.366 |
| Recent historical document  |               5 |        6.191 |              1 |       3.276 |            0.489 |           0.291 |
| Fork-depth history (100)    |               8 |        8.251 |              8 |       6.183 |            2.219 |           0.304 |
| Fork-depth head             |              18 |       15.681 |             18 |      13.936 |            1.748 |           0.238 |

**Port differences and reasons**

Reference paths below are relative to Pi's durable package. Every ported implementation has its file/symbol reference in JSDoc.

- `database.ts`, guided by `src/storage/sqlite/database.ts:SqliteExecutor/SqliteDatabase`: `get` returns plain `Option<T>` rather than `T | undefined`, as ruled by the orchestrator. The Storage implementation infers Pi's types and converts at its boundary. No Effect runtime enters the adapter.
- The owned facade adds `PostgresStatement`, `PostgresCommit`, `runBatch` and `transactionWithReads`. PostgreSQL cannot bind multiple statements through its extended protocol. The driver uses public `pg.escapeLiteral` for ordered simple-protocol batches, including lossless bigint text and byte-array hex. Prepared final segments are acknowledged only after COMMIT succeeds.
- `pg.ts`, guided by `src/storage/sqlite/node.ts:NodeSqliteExecutor/NodeSqliteDatabase/openNodeSqliteStorage`: `?` bindings become `$n` for ordinary queries. Batched bindings become safely quoted literals. SQLite's prepared-statement cache is not transplanted onto a leased pooled connection; queries remain unnamed.
- A supplied Pool owns connections and configuration. The opener leases one connection, validates the required ASCII schema identifier before any SQL, restricts search_path, restores its previous value on close and releases the lease. It never constructs or ends the host Pool. File creation, WAL/checkpoint and busy-timeout settings have no PostgreSQL equivalent here.
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

All seven exercised forms take one call and no explicit read transaction:

- Global entry: one indexed immutable row.
- Scoped entry: recursive immutable ancestry carries the minimum inclusive parent cutoff; unknown requested conversations retain their error. Session guarantees valid acyclic ancestry.
- Task: one current replacement row.
- Submission: one current receipt row.
- Submission by request: one conversation/request indexed lookup.
- Find document: one indexed address/lifetime lookup.
- Document: one lateral newest-base lookup and ordered delta aggregate. One PostgreSQL statement supplies the same snapshot Pi protected with three reads in a transaction. Only envelope fields are constructed as JSON; persisted record/content TEXT remains unparsed by PostgreSQL. BIGINT envelope fields are strings. Lifetime/current-only/base/version checks and Chord replay retain their original order.

**Verification commands and results**

`VIVID_TEST_DATABASE_URL` denotes only the disposable database on port 55449; no credentials or URL are recorded here. Package commands run from `packages/agent/durable`; lint/audit/version/format commands run from the repository root. Every Vitest invocation uses two workers and serial files, with no concurrent test/typecheck.

| Command                                                                                                                                                | Final result                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIVID_TEST_DATABASE_URL=<disposable-url> pnpm exec vitest run src/postgres --maxWorkers=2 --no-file-parallelism`                                      | 4 files, 39 tests passed; **23/23 upstream conformance**, unmodified, none skipped. Migration, rollback, driver and both end-to-end reopen/approval cases pass. |
| `VIVID_TEST_DATABASE_URL=<disposable-url> DURABLE_LIVE=0 pnpm exec vitest run --maxWorkers=2 --no-file-parallelism`                                    | 33 files passed, 1 skipped; **275 passed, 1 existing expected failure, 2 live tests skipped**.                                                                  |
| `env -u VIVID_TEST_DATABASE_URL DURABLE_LIVE=0 pnpm exec vitest run --maxWorkers=2 --no-file-parallelism`                                              | 29 files passed, 5 skipped; **236 passed, 1 existing expected failure, 41 skipped** including all 39 PostgreSQL tests.                                          |
| `pnpm typecheck`                                                                                                                                       | Passed.                                                                                                                                                         |
| `pnpm exec oxlint --type-aware packages/agent/durable/src/postgres`                                                                                    | 0 errors, 0 warnings.                                                                                                                                           |
| `pnpm audit:effect-boundaries`                                                                                                                         | 407 files, 333 findings; 0 unallowlisted, no stale or duplicate entries.                                                                                        |
| `pnpm check:versions`                                                                                                                                  | Passed.                                                                                                                                                         |
| `pnpm exec oxfmt --check packages/agent/durable scripts/effect-boundary-allowlist.json`                                                                | Passed.                                                                                                                                                         |
| `git diff --check`                                                                                                                                     | Passed.                                                                                                                                                         |
| `VIVID_TEST_DATABASE_URL=<disposable-url> VIVID_DURABLE_POSTGRES_BENCHMARK=1 pnpm exec node --experimental-transform-types src/postgres/bench/main.ts` | Passed; smallest-scale tables above, PostgreSQL and SQLite expected results verified.                                                                           |
| `pnpm exec node --experimental-transform-types packages/agent/durable/src/postgres/bench/main.ts`                                                      | Benchmark skipped by default, exit 0.                                                                                                                           |

Initial lint findings were fixed by hoisting compiled Schema predicates and extracting nested callbacks; no rule was disabled. One new test's TaskId generic was corrected after typecheck. A stale counter allowlist entry was removed. Final checks pass. The inherited expected failure and live skips were not changed. No timeout was raised and no sleep or polling was added.

**README lines to add — README was not edited**

> PostgreSQL storage is available from `@vivid/durable/postgres`. Pass a host-owned `pg` Pool and a required schema identifier to `openPgStorage(pool, schema)`, then supply that storage to your Pi Harness. PostgreSQL 16 or newer is required; this adapter was tested against PostgreSQL 18. Records and tool output remain JSON text. Closing storage releases its connection and does not end the host's pool. One process owns a storage at a time; there is no cross-process locking.

```ts
import { openPgStorage } from '@vivid/durable/postgres'

const storage = await openPgStorage(pool, 'durable')
```

**Limits and cleanup**

No production/app database, remote host, live provider, cross-process ownership, alternate driver, PostgreSQL 16/17, remote-network latency or sustained streaming throughput was tested. No repository-wide gate or typecheck was run for this revision. Only the host-supplied pg adapter and its real local PostgreSQL conformance were proved. No frontend work was performed.

All schema fixtures register cleanup before migration writes. Final cleanup verifies no lane test schemas remain, then removes only the container started by this lane with `docker rm -f durable-pg-lane`.
