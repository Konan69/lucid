# GitHub Actions

Complete setup guide for Turborepo with GitHub Actions.

## Basic Workflow Structure

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build and Test
        run: pnpm exec turbo run build test lint
```

## Package Manager Setup

Vivid's `packageManager` field owns the exact pnpm version, so the setup action reads it directly.

```yaml
- uses: pnpm/action-setup@v4

- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: "pnpm"

- run: pnpm install --frozen-lockfile
```

## Remote Cache Setup

### 1. Create Vercel Access Token

1. Go to [Vercel Dashboard](https://vercel.com/account/tokens)
2. Create a new token with appropriate scope
3. Copy the token value

### 2. Add Secrets and Variables

In your GitHub repository settings:

**Secrets** (Settings > Secrets and variables > Actions > Secrets):

- `TURBO_TOKEN`: Your Vercel access token

**Variables** (Settings > Secrets and variables > Actions > Variables):

- `TURBO_TEAM`: Your Vercel team slug

### 3. Add to Workflow

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
      TURBO_TEAM: ${{ vars.TURBO_TEAM }}
```

## Alternative: actions/cache

If you can't use remote cache, cache Turborepo's local cache directory:

```yaml
- uses: actions/cache@v4
  with:
    path: .turbo
    key: turbo-${{ runner.os }}-${{ hashFiles('**/turbo.json', '**/pnpm-lock.yaml') }}
    restore-keys: |
      turbo-${{ runner.os }}-
```

Note: This is less effective than remote cache since it's per-branch.

## Complete Example

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
      TURBO_TEAM: ${{ vars.TURBO_TEAM }}

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - uses: pnpm/action-setup@v3
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: turbo run build --affected

      - name: Test
        run: turbo run test --affected

      - name: Lint
        run: turbo run lint --affected
```
