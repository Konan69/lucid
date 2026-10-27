# Run the one-off history reader

Keep this directory on the one-off branch. The product image supplies Node 24 and `runs:adopt`.

Build the single-file reader with the repository's pinned esbuild.

```sh
pnpm --dir scripts/oneoff install --frozen-lockfile
node scripts/oneoff/bundle.mjs /tmp/vivid-history-reader.cjs
```

Copy that artifact into the server container. Run it from `/app`, with the runtime token in a mode-0600 file. Supply the database, notes directory, cell ingress URLs and map explicitly.

```sh
node /tmp/vivid-history-reader.cjs \
  --source "$DATABASE_URL" \
  --notes /var/lib/vivid/memory \
  --cells "$VIVID_RUNTIME_URL" \
  --token /tmp/runtime-token \
  --map /tmp/history-map.json
```

The reader opens its database source read-only. It copies each notes database and WAL to scratch before opening it read-only with Node SQLite. It preserves note modification times and uses basis `said`.

The map is replaced before `runs:adopt` starts. Adoption output stays visible. Refused Threads leave a partial map, still run adoption, and then exit nonzero with their ids. An identical rerun preserves the map and receipts.

The disposable-copy proof runs after a clean product-head `verify launch` and Doctor. It reads `~/migrate-copy` without changing it. The table-filtered dump lacks its enum and foreign-key targets. The proof reads the enum from the generated migration and omits foreign-key declarations only in the disposable restore. It copies Person, Thread and Run rows into the proof stack. It never copies production sessions or provider credentials.

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  scripts/oneoff/dry.mjs /absolute/product-checkout pi-<run>
```

Evidence stays under the verify run's `migration/` directory. The source database is dropped in `finally`. Run `verify cleanup` afterwards to remove the proof stack and its private scratch.

Open three copied Threads in the real client with the browser proof. It temporarily assigns only the disposable synthetic session to a copied Person, checks the Thread list and Runs, then restores that session. The copy contains three tool-result images and no user-uploaded pictures. The current client exposes tool-image kind and MIME type without drawing their bytes.

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  scripts/oneoff/browser.mjs /absolute/product-checkout pi-<run>
```
