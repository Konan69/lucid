# Discord Integration

Model requirement: needs a real model. Rehearsal cannot call Integration tools. The recipe also needs a Discord test bot. Without it the recipe reports `blocked: needs Discord test bot` and exits unsuccessfully.

## Behaviour and entry points

[discord.ts](../../../../apps/server/src/connections/discord.ts) authors `vivid/discord`. Its Key authorization has one field, `token`. The deployed app has three reads (`users.listMyGuilds`, `guilds.listGuildChannels`, `channels.listMessages`) and three writes (`channels.createMessage`, `channels.createThreadFromMessage`, `channels.editMessage`). [executor.ts](../../../../apps/server/src/connections/executor.ts) lists it in the catalog and deploys it on Begin.

A Person connects it for themselves ("For you") with a bot token. Vivid uses it from a Thread in that Person's Company. A personal Integration used in a Company-shared Thread always raises an Approval, reads included ([gate.ts](../../../../apps/server/src/approvals/gate.ts), `PersonalInShared`). The Person allows it on the card above the composer.

## Prerequisites

Create a bot at discord.com/developers/applications and invite it to a test server. It needs View Channel, Send Messages and Read Message History in one test channel. Keep its token in a private file (mode 0600) on the selected host.

| Variable                          | Value                                      |
| --------------------------------- | ------------------------------------------ |
| `VIVID_VERIFY_DISCORD_TOKEN_FILE` | Path to the file that holds the bot token. |
| `VIVID_VERIFY_DISCORD_GUILD`      | The test server id.                        |
| `VIVID_VERIFY_DISCORD_CHANNEL`    | The test channel id in that server.        |

The token is read into memory only. It never goes into argv, stdout or evidence. `CompleteConnection` is called without an evidence directory, and Discord REST evidence records method, path, status and body without headers. After the journey the recipe scans the run's evidence (not the private `instance/` scratch) for the token. A copy is replaced with `<redacted>` and fails the feature.

## Run the recipe

After Launch and Doctor on the unchanged commit, export the three variables and run the recipe with the explicit run id.

```sh
VIVID_VERIFY_DISCORD_TOKEN_FILE=/private/discord-token VIVID_VERIFY_DISCORD_GUILD=<guild> VIVID_VERIFY_DISCORD_CHANNEL=<channel> \
  .agents/skills/verify-vivid/verify feature discord pi-<id>
```

1. Discord REST reads `/users/@me` for the bot id and checks that the channel belongs to the guild.
2. `CreateCompany` makes a disposable Company and enters it. `Me` must report that Company as the workspace.
3. `FindServices` must list `vivid/discord`. `BeginConnection` with `shared: false` must ask for exactly the `token` field. `CompleteConnection` must answer Ready.
4. `CreateThread` makes a Thread in the Company, and `ShareThread` shares it with the Company.
5. A Person message asks Vivid to post a unique nonce to the channel. Each Pending Approval is allowed through `DecideApproval` (AllowOnce) and must return Succeeded. WatchThread waits for each Decision Run. Exactly one Succeeded `channels.createMessage` Approval must name this Connection.
6. Discord REST reads the last 20 channel messages. Exactly one contains the nonce, and the bot is its author.
7. A second message asks Vivid to read and summarize the channel. A Succeeded `channels.listMessages` Approval on this Connection is the tool receipt.

Cleanup always runs. It removes the Connection through `RemoveConnection`, deletes every message that holds the nonce through Discord REST, and switches the session back to Personal. Each failed step is recorded and fails the feature.

## Evidence

Evidence is under `discord/`. `proof.json` records the nonce, guild, channel, Discord message id, bot id, Company, Thread and Connection. `discord-messages.json` is the independent Discord read. `post-allow-*.json` and `read-allow-*.json` are the decisions, and `settlement.json`, `post-history.json` and `read-history.json` are the Thread. `cleanup.json` records the removed Connection, deleted message ids, final workspace and cleanup errors. `redaction.json` lists any file in which the token was found.

## Blocked subcases

- The browser Key form and the Allow card need a browser recipe. `verify browser discord` reports `no browser recipe`.
- `create_thread_from_message`, `edit_message`, `list_my_guilds` and `list_guild_channels` are not driven.
- A Company-shared Connection (`shared: true`) and a private Company Thread, where the Gate may run a write without an Approval, are not driven.
- The disposable Company is not deleted. It is removed with the run's database at Cleanup.
