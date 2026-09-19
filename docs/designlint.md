# Web design-system lint

The root Oxlint config applies design rules only to `apps/web/src/**/*.tsx`. React Native does not share this Tailwind surface. `apps/web/components.json` points component discovery at `apps/web/src/ui` and theme discovery at `apps/web/src/styles/index.css`; that entry imports `packages/design-tokens/src/tokens.css`.

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
^(Avatar|Face|StatusLabel|StatusDot|ToolMarks)$ allow: layout

# All other discovered design-system components.
default                                      allow: layout
```

The component-definition directory turns `no-restyle`, `no-arbitrary-values`, and `require-static-classes` off, as the plugin setup guide requires: definitions must declare their own styles and forward caller classes. Raw-color, inline-style, and Tailwind checks still inspect those files.

## Current ratchets

Counts were measured against the current web source without modifying components. Warning values are ceilings; lower them when findings disappear.

| Rule | Level | Baseline |
| --- | --- | ---: |
| `shadcn/no-restyle` | error | 0 |
| `shadcn/no-raw-colors` | warn | 32 |
| `shadcn/no-arbitrary-values` | warn | 51 |
| `shadcn/no-inline-styles` | warn | 27 |
| `shadcn/no-unknown-classes` | warn | 3 |
| `shadcn/require-static-classes` | error | 0 |
| `tailwindcss/no-duplicate-classes` | error | 0 |
| `tailwindcss/no-conflicting-classes` | warn | 6 |
| `tailwindcss/no-deprecated-classes` | error | 0 |
| `tailwindcss/no-unnecessary-whitespace` | error | 0 |
| `tailwindcss/no-dark-without-light` | error | 0 |
| `tailwindcss/no-contradicting-variants` | error | 0 |
| `tailwindcss/enforce-canonical` | warn | 3 |
| `tailwindcss/enforce-sort-order` | warn | 60 |
| `tailwindcss/enforce-shorthand` | warn | 10 |
| `tailwindcss/enforce-consistent-important-position` | error | 0 |
| `tailwindcss/enforce-negative-arbitrary-values` | error | 0 |
| `tailwindcss/enforce-consistent-variable-syntax` | error | 0 |
| `tailwindcss/consistent-variant-order` | error | 0 |
