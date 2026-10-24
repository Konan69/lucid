# Web design-system lint

The root Oxlint config applies design rules only to `apps/web/src/**/*.tsx`. React Native does not share this Tailwind surface. `apps/web/components.json` points component discovery at `apps/web/src/ui` and theme discovery at `apps/web/src/styles/index.css`; that entry imports `packages/design/tokens/src/tokens.css`.

## The components are shadcn's

`apps/web/src/ui` holds shadcn components written by the shadcn CLI (`base-mira` style on Base UI, `apps/web/components.json`), under the CLI's own lowercase file names so `pnpm dlx shadcn@latest add <name>` (run from `apps/web`) can add or refresh one. Vivid's compositions of them sit beside them in PascalCase files (`Segmented.tsx`, `Person.tsx`, `Face.tsx`).

A component the CLI writes is then drawn as Vivid's, in the file, once:

- it imports `cn` from `@/ui/cn` (the CLI writes `from "cn"`; Vivid's is configured with the theme's own class names),
- type is Vivid's scale (`text-label`, `text-title`), radii are `rounded-row|control|card|dialog`,
- a layer is `edge`, a floating layer `lift` or `lift-lg` with `glass`; no `shadow-*` plus `ring-*` pairs,
- what floats moves with `motion-pop` or `motion-dialog` (which carry the exit Base UI waits for), never `animate-in`,
- no `dark:` classes: the tokens change with the theme,
- a popup takes `ref={countSurface}` so the desktop app knows something floats over the page.

shadcn's colour names are theme entries derived from Vivid's roles (`packages/design/tokens/src/tokens.css`), so an unedited registry component is already on Vivid's layers. `primary` is the brand colour. `accent` is shadcn's word for the fill under the pointer; it is not the brand colour.

## Ownership

`@shadcn/lint@0.1.1` owns component usage, semantic colors, arbitrary values, inline styles, unknown classes, and static class readability. `oxlint-tailwindcss@1.12.0` owns non-overlapping Tailwind correctness and canonical syntax. The Tailwind plugin's unknown-class, hardcoded-color, arbitrary-value, and theme-token checks stay disabled because the shadcn rules already report those policies with Vivid-specific guidance.

Logical-versus-physical utilities, restricted-class lists, and class-count limits remain unset because each requires a product/design decision; enabling both direction rules would conflict. The UI owner should decide those policies before enforcement.

## Draft component contracts

This is the first draft for UI-owner review. The executable source is the single `shadcn/no-restyle` contract array in `.oxlintrc.json`.

```text
# Button and IconButton own spacing, shape, typography, color, effects, and motion.
^(Button|IconButton)$                         allow: layout

# Card owns surface, radius, and elevation; callers place it and space content.
^Card$                                        allow: layout, spacing

# Small visual primitives own their treatment; callers place them.
^(Avatar|PersonAvatar|Face|StatusLabel|StatusDot)$ allow: layout

# All other discovered design-system components.
default                                      allow: layout
```

The component-definition directory turns `no-restyle`, `no-arbitrary-values`, and `require-static-classes` off, as the plugin setup guide requires: definitions must declare their own styles and forward caller classes. Raw-color, inline-style, and Tailwind checks still inspect those files.

## Current ratchets

Baselines below are the executable ceilings in `scripts/gate/ratchets.mjs`, checked on 3 October 2026.
They are not fresh measurements of source findings. Rule levels come from `.oxlintrc.json`;
lower a ceiling when findings disappear.

| Rule                                                | Level | Baseline |
| --------------------------------------------------- | ----- | -------: |
| `shadcn/no-restyle`                                 | error |        0 |
| `shadcn/no-raw-colors`                              | warn  |        0 |
| `shadcn/no-arbitrary-values`                        | warn  |        0 |
| `shadcn/no-inline-styles`                           | warn  |        0 |
| `shadcn/no-unknown-classes`                         | warn  |        0 |
| `shadcn/require-static-classes`                     | error |        0 |
| `tailwindcss/no-duplicate-classes`                  | error |        0 |
| `tailwindcss/no-conflicting-classes`                | warn  |        0 |
| `tailwindcss/no-deprecated-classes`                 | error |        0 |
| `tailwindcss/no-unnecessary-whitespace`             | error |        0 |
| `tailwindcss/no-dark-without-light`                 | error |        0 |
| `tailwindcss/no-contradicting-variants`             | error |        0 |
| `tailwindcss/enforce-canonical`                     | warn  |        0 |
| `tailwindcss/enforce-sort-order`                    | warn  |        0 |
| `tailwindcss/enforce-shorthand`                     | warn  |        0 |
| `tailwindcss/enforce-consistent-important-position` | error |        0 |
| `tailwindcss/enforce-negative-arbitrary-values`     | error |        0 |
| `tailwindcss/enforce-consistent-variable-syntax`    | error |        0 |
| `tailwindcss/consistent-variant-order`              | error |        0 |

## Brand marks keep literal colours

Third-party logos keep their brand colours in both themes. Service logos live in
`apps/web/src/screen/integration/logos/` and are drawn by `Mark.tsx`. Google's sign-in mark keeps
its colours beside its paths in `apps/web/src/screen/welcome/Google.tsx`. The unused `ServiceMarks`
component and its raw-colour lint exception were removed.
