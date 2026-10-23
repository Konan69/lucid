---
name: image-gen
description: Generate or edit high-quality images through Cloudflare unified AI with GPT Image 2.5 Sunburst (default), Flare, or GPT Image 2. Use for image creation, drafts, and reference-image editing. Read references/prompting.md and references/styles.md before writing the prompt.
---

# Image generation

Cloudflare unified AI only. No provider keys. Default model: `openai/gpt-image-2.5-sunburst`, **quality `high`** (unless `--quality` supplied). **`max` is the benchmarked top-quality setting** and costs more; use `--quality max` when maximum quality justifies the extra tokens. Flare is for faster drafts, not a documented lower per-token rate.

```bash
python3 scripts/generate_image.py --prompt 'A ceramic cup in soft morning light' --output cup.png --size 1536x1024
python3 scripts/generate_image.py --model openai/gpt-image-2.5-sunburst --quality max --prompt 'Detailed editorial cover' --output cover.png
python3 scripts/generate_image.py --model openai/gpt-image-2.5-flare --prompt 'Quick composition' --output draft.webp --output-format webp --dry-run
python3 scripts/generate_image.py --input-image ref.png --prompt 'Preserve the subject; change the setting' --output edit.png
```

| Model | Use | Cloudflare output-image price |
|---|---|---|
| `openai/gpt-image-2.5-sunburst` (default) | Best quality | $30/1M output image tokens |
| `openai/gpt-image-2.5-flare` | Fast drafts | $30/1M output image tokens |
| `openai/gpt-image-2` | Previous generation baseline | $30/1M output image tokens |

Flags: `--model` (only IDs above), `--prompt`, `--output`, `--size 1024x1024|1024x1536|1536x1024|auto`, `--quality low|medium|high|xhigh|max|auto` (GPT Image 2 only low/medium/high/auto), `--background transparent|opaque|auto`, `--output-format png|webp|jpeg`, repeatable `--input-image` (up to 16 PNG/JPEG/WebP), `--dry-run`. Media data URIs are truncated in dry-run output. The saved extension follows actual response MIME.

**Auth:** `CLOUDFLARE_API_TOKEN`, else first `oauth_token` in `~/.wrangler/config/default.toml` or `~/.config/.wrangler/config/default.toml`. Account: `CLOUDFLARE_ACCOUNT_ID`, else GET `/client/v4/accounts` and require exactly one. Token is never printed; permission: Account → Workers AI → Read.

References: `references/api.md` for exact Cloudflare schemas, `references/prompting.md`, `references/styles.md`, `references/examples.md`.
