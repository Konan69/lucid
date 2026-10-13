# Cloudflare image API

`POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run` with `Authorization: Bearer {token}`:

```json
{"model":"openai/gpt-image-2.5-sunburst","input":{"prompt":"...","size":"1536x1024","quality":"high","output_format":"png","images":["data:image/png;base64,..."]}}
```

Models **only** `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-2.5-flare`, `openai/gpt-image-2`. Sunburst default quality: `high`; explicit `max` is the benchmarked setting, with higher output-token cost. Sunburst/Flare enums: `low|medium|high|xhigh|max|auto`; GPT Image 2: `low|medium|high|auto`. All three sizes: `1024x1024|1024x1536|1536x1024|auto`; output format: `png|webp|jpeg`; background: `transparent|opaque|auto`. Up to 16 image references as PNG/JPEG/WebP base64 data URIs. Response `result.image` URL or base64 data; download/decode and use real MIME for file extension.

Auth: `CLOUDFLARE_API_TOKEN`, else first `oauth_token` from `~/.wrangler/config/default.toml` or `~/.config/.wrangler/config/default.toml`. Account: `CLOUDFLARE_ACCOUNT_ID`, else GET `/client/v4/accounts` and require exactly one. No provider key. `--dry-run` makes no network calls and truncates data URIs.

Docs: [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/index.md), [Sunburst](https://developers.cloudflare.com/ai/models/openai/gpt-image-2.5-sunburst/index.md), [Flare](https://developers.cloudflare.com/ai/models/openai/gpt-image-2.5-flare/index.md), [GPT Image 2](https://developers.cloudflare.com/ai/models/openai/gpt-image-2/index.md).

## Cost per quality (output image only, $30 / 1M image tokens)

Computed with OpenAI's own token formula (GptImageTokenCalculator on the image-generation guide, checked 2026-09-28). Sunburst and Flare cost the same; input text/reference-image tokens are extra.

| gpt-image-2.5 | 1024² | 1536×1024 | 2048×1152 | 3840×2160 |
|---|---|---|---|---|
| low | $0.006 | $0.005 | $0.005 | $0.011 |
| medium | $0.013 | $0.010 | $0.011 | $0.026 |
| high (default) | $0.053 | $0.041 | $0.042 | $0.100 |
| xhigh | $0.094 | $0.074 | $0.075 | $0.178 |
| max | $0.211 | $0.165 | $0.170 | $0.400 |

gpt-image-2: low = 2.5 low, medium = 2.5 high, high = 2.5 max.
Rule: explore at medium, lock frames at high, finals at xhigh; max only for a single hero frame.
