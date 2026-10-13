#!/usr/bin/env python3
"""Generate images using three OpenAI models on Cloudflare unified AI."""
import argparse
import base64
import binascii
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
MODELS = ("openai/gpt-image-2.5-sunburst", "openai/gpt-image-2.5-flare", "openai/gpt-image-2")
EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def request_json(url, token, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                                 method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=900) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        fail(f"Cloudflare HTTP {exc.code} (check token and account).")
    except (urllib.error.URLError, TimeoutError) as exc:
        fail(f"Cloudflare request failed: {exc}")
    if payload.get("success") is False:
        fail(f"Cloudflare API error: {str(payload.get('errors', []))[:500]}")
    return payload


def auth():
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        for path in ("~/.wrangler/config/default.toml", "~/.config/.wrangler/config/default.toml"):
            path = os.path.expanduser(path)
            if os.path.isfile(path):
                with open(path, encoding="utf-8") as f:
                    match = re.search(r'^oauth_token\s*=\s*"([^\"]+)"', f.read(), re.M)
                if match:
                    token = match.group(1)
                    break
    if not token:
        fail("set CLOUDFLARE_API_TOKEN or log in with Wrangler (oauth_token missing).")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not account:
        found = request_json(f"{API}/accounts", token).get("result") or []
        if len(found) != 1:
            fail(f"Cloudflare account lookup returned {len(found)} accounts; set CLOUDFLARE_ACCOUNT_ID.")
        account = found[0]["id"]
    return token, account


def build(args):
    if args.model == "openai/gpt-image-2" and args.quality in ("xhigh", "max"):
        fail("openai/gpt-image-2 supports quality low, medium, high, auto only.")
    if args.size and args.size not in ("1024x1024", "1024x1536", "1536x1024", "auto"):
        fail("size must be 1024x1024, 1024x1536, 1536x1024, or auto.")
    if len(args.input_image) > 16:
        fail("maximum 16 --input-image values.")
    inp = {"prompt": args.prompt}
    for name in ("size", "quality", "background", "output_format"):
        value = getattr(args, name)
        if value is not None:
            inp[name] = value
    if args.model == MODELS[0] and args.quality is None:
        inp["quality"] = "high"
    if args.input_image:
        inp["images"] = []
        for path in args.input_image:
            mime = mimetypes.guess_type(path)[0]
            if mime not in ("image/png", "image/jpeg", "image/webp"):
                fail(f"input must be PNG, JPEG, or WebP: {path}")
            try:
                with open(path, "rb") as f:
                    data = base64.b64encode(f.read()).decode("ascii")
            except OSError as exc:
                fail(f"cannot read image {path}: {exc}")
            inp["images"].append(f"data:{mime};base64,{data}")
    return {"model": args.model, "input": inp}


def save_image(payload, path):
    if payload.get("state") not in (None, "Completed") or payload.get("error"):
        fail(f"image generation failed: state={payload.get('state')}, error={str(payload.get('error'))[:300]}")
    result = payload.get("result") or payload
    # Cloudflare now wraps the model output once more: result.result.image.
    if isinstance(result, dict) and isinstance(result.get("result"), dict):
        if result.get("state") not in (None, "Completed"):
            fail(f"image generation failed: state={result.get('state')}")
        result = result["result"]
    image = result.get("image") if isinstance(result, dict) else None
    if not image:
        fail("Cloudflare response contains no result.image URL or base64 data.")
    if image.startswith("data:"):
        header, encoded = image.split(",", 1)
        mime = header[5:].split(";", 1)[0]
        raw = base64.b64decode(encoded)
    elif image.startswith("https://"):
        try:
            with urllib.request.urlopen(image, timeout=180) as response:
                mime = response.headers.get_content_type()
                raw = response.read()
        except urllib.error.URLError as exc:
            fail(f"image download failed: {exc}")
    else:
        mime = None
        try:
            raw = base64.b64decode(image, validate=True)
        except (ValueError, binascii.Error):
            fail("result.image is neither an HTTPS URL nor base64 data.")
    if mime not in EXT:
        mime = ("image/png" if raw.startswith(b"\x89PNG") else
                "image/jpeg" if raw.startswith(b"\xff\xd8") else
                "image/webp" if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP" else None)
    root, old_ext = os.path.splitext(path)
    if mime in EXT and old_ext.lower() != EXT[mime]:
        path = root + EXT[mime]
        print(f"note: response is {mime}; saving to {path}", file=sys.stderr)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as f:
        f.write(raw)
    print(path)


def main():
    ap = argparse.ArgumentParser(description="Generate an image via Cloudflare unified AI.")
    ap.add_argument("--model", choices=MODELS, default=MODELS[0])
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--size")
    ap.add_argument("--quality", choices=("low", "medium", "high", "xhigh", "max", "auto"))
    ap.add_argument("--background", choices=("transparent", "opaque", "auto"))
    ap.add_argument("--output-format", choices=("png", "webp", "jpeg"))
    ap.add_argument("--input-image", action="append", default=[])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    body = build(args)
    if args.dry_run:
        preview = json.loads(json.dumps(body))
        if args.input_image:
            preview["input"]["images"] = [v[:65] + "...[truncated]" for v in body["input"]["images"]]
        print(json.dumps(preview, indent=2))
        return
    token, account = auth()
    save_image(request_json(f"{API}/accounts/{account}/ai/run", token, body), args.output)


if __name__ == "__main__":
    main()
