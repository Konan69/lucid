# Read public pages

Model requirement: real. Use `https://www.notion.so/settings/mcp` for the production script-only case, falling back only to `https://app.notion.com/notion-mcp` if the first no longer serves the notice. Use `https://example.com/` for the ordinary page regression. No tunnel or private-network exception is allowed.

After Launch and worthy Doctor, run `verify feature pages <run>` and `verify browser pages <run>`, then Cleanup on the unchanged head. Source is `.agents/skills/verify-vivid/scripts/pages.mjs`. Evidence is under `pages/` and `browser/pages/`.

Before Launch, retain one `curl -sL` response from the selected devbox for the Notion address. The recipe also saves both status and full HTML for each address it examines. If neither contains the JavaScript-required notice, recipe 4 is blocked with those responses, never passed.

Ask Vivid to read the selected Notion page and say what it says. It must not claim the JavaScript notice is the page's content or claim it read the page. It must open the actual page with the Computer browser or plainly say it could not read it. Require the actual script-only read refusal receipt, followed by a successful browser opening of that address or a plain limitation in the saved reply. Review the exact saved words before a verdict. Do not turn a browser action alone into a reading claim.

Ask Vivid to read example.com and say what it says. Require an actual successful read receipt and the ordinary Example Domain content in the reply. Browser uses the composer and retains screenshots of each reply. `reply-*.json` and `history-*.json` retain the exact words and tool receipts. `step-*.json` records successful checkpoints. Native clients remain unproved.
