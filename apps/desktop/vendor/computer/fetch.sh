#!/usr/bin/env sh
# Fetches the Computer binaries from the repository's GitHub Releases, verifies every sha256,
# and places the pair where the desktop app looks for it. Idempotent: files that are already
# right are left alone; anything wrong or missing is downloaded again.
#
# The release is on the private repository, so the download goes through the `gh` CLI the
# repository's own workflows already rely on — an asset is fetched by id over the API, which
# returns its bytes when the caller can read this repository.
#
# Run from this directory: sh fetch.sh
set -eu

RELEASE_TAG=computer-v1

# The files and their checksums, exactly as `sha256sum` reported when they were uploaded.
SUMS='7c500f13ccfb4e13f53fe225a743f28bd5743a1cf4921c385b2de1ac6ffc9f45  codex-computer-use.exe
46ceb2f44b2e678bf159b9dc9a37f5a85c57aaa6d2fa52e087ac6f7a8f0d2b4b  swift/x64/codex-computer-use-swift.exe
51dde40a153fe9562a633b6213933e0f16c8faf48936cb6f8893e4b7ab400659  swift/x64/MSVCP140.dll
5d29a9177be66fc50f55eecfb3b32805da099942f9d0aabcc08ced740bcf1657  swift/x64/VCRUNTIME140.dll
96d86544d24065b6e9339b1140b1b9f097b5121bc311e6e921af86f16160612f  swift/x64/VCRUNTIME140_1.dll'

# One file, verified: its bytes must hash to exactly what was uploaded beside it.
matches() {
  printf '%s  %s\n' "$1" "$2" | sha256sum -c - >/dev/null 2>&1
}

mkdir -p swift/x64

echo "$SUMS" | while IFS= read -r line; do
  # Paths in this list never contain spaces, so plain word-splitting is the honest parse.
  set -- $line
  sum=$1
  file=$2
  if matches "$sum" "$file"; then
    echo "have   $file"
    continue
  fi
  echo "fetch  $file"
  # Release assets are flat; the pair's layout comes from this directory's own structure.
  assetfile=${file##*/}
  asset=$(gh api "repos/Konan69/vivid/releases/tags/$RELEASE_TAG" \
    --jq ".assets[] | select(.name == \"$assetfile\") | .id")
  gh api -H "Accept: application/octet-stream" "repos/Konan69/vivid/releases/assets/$asset" > "$file"
  if ! matches "$sum" "$file"; then
    echo "the Computer fetched $file and it does not match its checksum. It is not usable."
    rm "$file"
    exit 1
  fi
  echo "placed $file"
done

echo "The Computer binaries are in place."
