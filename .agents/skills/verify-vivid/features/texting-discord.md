# Text Vivid on Discord

Model requirement: needs a real model. The recipe also needs a Discord bot and a real Discord account that plays the Person. Without them it reports `blocked: needs Discord bot and tester account` and exits unsuccessfully.

## Behaviour and entry points

The server texts on Discord only when `VIVID_DISCORD_BOT_TOKEN` is set ([combined.ts](../../../../apps/server/src/channels/combined.ts)), and only for People whose email is in `VIVID_DISCORD_PEOPLE`. The supervisor lists the run's synthetic account. [discord.ts](../../../../apps/server/src/channels/discord.ts) holds a Chat SDK gateway session for the bot. It takes direct messages and messages that mention the bot, and ignores everything else.

`ConnectChannel` with `channel: 'Discord'` and no address stands the Person as `Awaiting` with a code and `textTo = discord:<bot id>` ([store.ts](../../../../apps/server/src/channels/store.ts)). The first message carrying that code links the sender's account and the bot answers "Connected." in reply to it ([inbound.ts](../../../../apps/server/src/channels/inbound.ts)). Later text from that account opens or continues the Person's one private Thread. When the Run settles, [replies.ts](../../../../apps/server/src/channels/replies.ts) answers in the same DM or channel as a reply to the Person's message, with every ping suppressed.

## Prerequisites

Use the test bot and server from [the Discord Integration recipe](discord.md). The bot needs View Channel, Send Messages and Read Message History in the test channel. A real Discord account (not a bot) joins that server and plays the Person. Keep each token in its own private file (mode 0600) on the selected host. The tester's token is that account's session token, sent as `Authorization: <token>` with a desktop User-Agent to API v9.

| Variable                               | Value                                                  |
| -------------------------------------- | ------------------------------------------------------ |
| `VIVID_VERIFY_DISCORD_TOKEN_FILE`      | Bot token file. Set at Launch and when running.        |
| `VIVID_VERIFY_DISCORD_USER_TOKEN_FILE` | Tester account token file.                             |
| `VIVID_VERIFY_DISCORD_CHANNEL`         | A server text channel both the bot and tester can see. |

Launch passes only the token file path to the supervisor. The supervisor reads it and sets `VIVID_DISCORD_BOT_TOKEN` in the server process env alone, never argv, state or evidence. A run launched without it stands Discord `Unavailable` and the feature fails. The recipe reads both tokens into memory. Discord REST evidence records method, path, status and the decoded answer, never headers. After the journey every evidence file (not the private `instance/` scratch) is scanned for both tokens. A copy is replaced with `<redacted>` and fails the feature.

## Run the recipe

```sh
VIVID_VERIFY_DISCORD_TOKEN_FILE=/private/discord-bot VIVID_VERIFY_DEVBOX=<alias> VIVID_VERIFY_KEY_FILE=/private/verify.env \
  .agents/skills/verify-vivid/verify launch
VIVID_VERIFY_DISCORD_TOKEN_FILE=/private/discord-bot VIVID_VERIFY_DISCORD_USER_TOKEN_FILE=/private/discord-tester \
  VIVID_VERIFY_DISCORD_CHANNEL=<channel> .agents/skills/verify-vivid/verify feature texting-discord pi-<id>
```

1. Discord REST reads `/users/@me` for the bot and the tester. A second bot gateway session opens and reaches READY before anything is sent. Discord pushes the bot's own messages to it, so every reply is awaited on that delivery, not polled.
2. `WatchChannels` shows Discord `NotConnected`. `ConnectChannel` answers `Awaiting` with a six-digit code and `textTo = discord:<bot id>`.
3. The tester opens a DM with the bot and sends the code. `WatchChannels` reaches `Connected` with `address = discord:<tester id>`. The bot's "Connected." reply to the code message arrives on the gateway and is read back with the bot token.
4. The tester DMs "Reply with exactly the word pineapple and nothing else." `WatchThreads` shows the new personal Thread and `WatchThread` waits for its Run to complete. The bot's reply to that DM contains "pineapple".
5. In the channel the tester posts a message without a mention, then `<@bot> Reply with exactly the word mango.` `WatchThread` waits for the second Run in the same Thread. The bot's reply to the mention contains "mango" with no everyone or role ping.
6. The worker takes channel text in order, so once the mention is answered the unmentioned message has been dropped. No bot message replies to it, the Thread has exactly two Runs, and its history holds only the pineapple and mango messages.

Cleanup always runs. It calls `DisconnectChannel` and waits for `WatchChannels` to show `NotConnected`. It deletes the tester's messages with the tester token and the bot's replies to them with the bot token. Each failed step is recorded and fails the feature.

## Evidence

Evidence is under `texting-discord/`. `proof.json` records the bot, tester, DM, channel, Thread and every message id. `channels-*.json` are the `WatchChannels` publications. `bot-confirmation.json`, `bot-dm-reply.json` and `bot-channel-reply.json` are the bot-token reads. `channel-after-unmentioned.json`, `thread.json` and `channel-history.json` back the absence check. `cleanup.json` records the final standing, deleted message ids and cleanup errors. `redaction.json` lists any file in which a token was found.

## Blocked subcases

- The Text Vivid screen's Discord connect needs a browser recipe. `verify browser texting-discord` reports `no browser recipe`.
- Phone channels (iMessage, WhatsApp), code expiry, a code from an account linked to another Person, and a reply longer than one 2000-character chunk are not driven.
- Gateway reconnects and messages sent while the bot is offline are not driven.
