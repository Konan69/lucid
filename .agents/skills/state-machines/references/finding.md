# Finding lifecycles

## What `vivid/react-no-state-after-wait` sees

`scripts/oxlint-plugin-vivid.mjs` (rule `reactNoStateAfterWait`) records setters from `const [x, setX] = useState(...)` and reports a direct call to one inside a function that has passed an `await`, a `yield*`, or an inline `.then`/`.catch`/`.finally` callback. Its tests in `scripts/oxlint-plugin-vivid.test.mjs` pin the blind spots on purpose.

It misses: a setter reached through a helper (`await send(); end()`), a named callback (`.then(renewed)`), a setter passed as a prop or returned from a hook, an alias, `setX(await save())` (the setter is visited before the wait), `Effect.ensuring`/`Effect.sync`/`Effect.map` callbacks, timers, subscriptions and native callbacks, `useReducer` dispatch, Zustand and custom stores, atoms, and status shapes that never wait in the same function. `.agents/skills/state-machines/scripts/find.sh` searches for these shapes.

The ceiling in `scripts/gate/ratchets.mjs` is an aggregate count, checked both ways: above it fails, and below it fails too until the ceiling is set to the measured number. It keeps no list of grandfathered sites.

## Shapes to recognise

- String states or a tagged union in `useState`.
- `busy`/`error` (or `pending`, `saving`, `sending`) pairs.
- Per-row status maps and in-flight `Set`s.
- A store with `status: 'Opening' | 'Waiting' | ...` (web `data/handoff.ts`, `data/threads.ts`, `data/arrival.ts`; phone `data/first.ts`, `data/signing.ts`, `data/google.ts`, `data/update.ts`).
- An error-only setter written after a command: still a lifecycle, even with no loading flag.

## False conversions

- A sheet or menu open flag, editable text, a selected option, a measured size: plain state. `creating` that only chooses whether a create form is shown is plain state, not an in-flight request.
- A value that mirrors the server (lists, records, Computer state, membership): a live query in `packages/client/state/src/live.ts`.
- Flue's run `status` (`packages/client/state/src/stream.ts`): library-owned; never mirror it into a machine.
- Existing protections must survive a conversion: Input-request and Approval attempt checks and proposal digests, key-sheet attempt ids, phone rule-text comparison, UUID-keyed upload rows, first-message delivery keys.

## Inventory on 24 October 2026 (main 2365c47f)

103 lint findings in 41 files (53 web, 50 phone), grouped into about 38 lifecycles. Highest severity first; re-run the lint and `find.sh` before relying on it.

- Library search and item opening; Library rename and move (web `screen/Library.tsx`).
- Memory correction (web and phone `screen/settings/Memory.tsx`).
- Membership roles, removal, leave, invitation revoke and invite (both `screen/settings/People.tsx`).
- Sending and retrying a message (web `screen/Thread.tsx`, phone `screen/Chat.tsx`); stopping a Run (phone `screen/Chat.tsx`).
- Thread audience (both `screen/*/Share.tsx`).
- Email and Google sign-in (web `screen/Welcome.tsx`); workspace switch (phone `screen/home/Switcher.tsx`).
- Creating a Company or Project (web `screen/sidebar/Company.tsx`, `screen/project/Create.tsx`; phone `ui/Sheet.tsx` submission).
- Accepting an invitation (web `screen/Invite.tsx`, phone `screen/notifications/Invitation.tsx`).
- Medium: key-form submission, empty Project Thread, Library upload, delete, move destinations, ask about or open a document, naming sheets, rules, preferences, web sign-out, Computer and device decisions, viewer renewal (web `screen/Computer.tsx`, phone `screen/computer/Live.tsx`), sessions, messaging channels, Integration removal, filing, appearance, Input answers and Approval decisions (partly guarded), attachments.
- Low: clipboard and share feedback, link opening.
