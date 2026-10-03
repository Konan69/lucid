# Audit

The record of consequential things that happened: one row per event, never updated or deleted.

- `tables.ts` and `record.ts`: appending an entry, always inside the transaction of the change it
  records, attributed to a Person, a Company when there is one, and to Vivid when Vivid acted.
- `store.ts`: reading the record. A Company's admins see the Company's entries; a Member sees only
  their own.
- `handlers.ts`: the RPC surface behind Settings → Record.

The events themselves are declared once, in `packages/contracts/src/audit.ts`. A domain that makes
a consequential change appends its own entry; nothing writes the record after the fact.
