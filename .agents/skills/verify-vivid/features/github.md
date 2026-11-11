# GitHub Integration

Model requirement: needs a real model. Rehearsal cannot call Integration tools. The recipe also needs a GitHub personal token. Without it the recipe reports `blocked: needs a GitHub personal token` and exits unsuccessfully.

## Behaviour and entry points

[curation.json](../../../../apps/server/src/connections/curation.json) lists `curated/github-com-mcp`, named GitHub, with a personal-token policy under `keyed`. Its address is GitHub's own remote MCP server, `https://api.githubcopilot.com/mcp/` (it calls itself `github-mcp-server`). The host is Copilot's, but the server acts as the token's owner. [executor.ts](../../../../apps/server/src/connections/executor.ts) lists it in the catalog whether or not Executor's feed answers, and [keyed.ts](../../../../apps/server/src/connections/keyed.ts) deploys its Executor app on Begin.

## Prerequisites

A fine-grained or classic GitHub token that can read its owner's profile. Keep it in a private file (mode 0600) on the selected host and set `VIVID_VERIFY_GITHUB_TOKEN_FILE` to its path. The token is read into memory only. `CompleteConnection` is called without an evidence directory, and the GitHub REST read records its status and login without headers. After the journey the recipe scans the run's evidence for the token, replaces any copy with `<redacted>` and fails the feature.

## Run the recipe

After Launch and Doctor on the unchanged commit, run the recipe with the explicit run id.

```sh
VIVID_VERIFY_GITHUB_TOKEN_FILE=/private/github-token .agents/skills/verify-vivid/verify feature github pi-<id>
```

1. GitHub REST `GET /user` reads the token owner's login.
2. `FindServices` for GitHub must list `curated/github-com-mcp` named GitHub. `BeginConnection` with `shared: false` must ask for exactly the `token` field. `CompleteConnection` must answer Ready with the service name GitHub.
3. In the personal Thread the feature run made, the Person asks "What's my GitHub username?". Any Pending Approval is allowed, and WatchThread waits for the Run. The last assistant message must name the login from step 1. Nothing else in the disposable account names it.

Cleanup always runs. It removes the Connection through `RemoveConnection`.

## Blocked subcases

- The web Key form has no browser recipe.
- Adding the same server by address names it after what the model chooses, not GitHub. Only the catalog entry is checked here.
