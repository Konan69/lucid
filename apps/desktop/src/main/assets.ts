import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const mediaTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.wasm', 'application/wasm'],
  ['.mp4', 'video/mp4'],
])

/** A missing packaged asset is distinct from a server being unreachable. */
export class RendererAssetUnavailable extends Schema.TaggedError<RendererAssetUnavailable>()(
  'RendererAssetUnavailable',
  {},
  { title: 'Packaged renderer asset is unavailable' },
) {}

/** Malformed percent escapes must not throw out of an Electron protocol callback. */
export class RendererPathInvalid extends Schema.TaggedError<RendererPathInvalid>()(
  'RendererPathInvalid',
  {},
  { title: 'Packaged renderer path is invalid' },
) {}

/** Resolve only contained assets; extensionless document navigation uses the SPA entry point. */
export const rendererAssetPath = Effect.fn('DesktopRenderer.assetPath')(function* (
  root: string,
  pathname: string,
  navigation: boolean,
) {
  const decoded = yield* Effect.try({
    try: () => decodeURIComponent(pathname),
    catch: () => new RendererPathInvalid({}),
  })
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) {
    return Option.none<string>()
  }
  const relative =
    decoded === '/' || (navigation && NodePath.extname(decoded) === '')
      ? 'index.html'
      : `.${decoded}`
  const resolved = NodePath.resolve(root, relative)
  if (!resolved.startsWith(`${NodePath.resolve(root)}${NodePath.sep}`)) return Option.none<string>()
  return Option.some(resolved)
})

/** Serve built bytes with their real type; symlinks cannot escape the packaged asset directory. */
export const serveAsset = Effect.fn('DesktopRenderer.serveAsset')(function* (
  root: string,
  request: Request,
  url: URL,
) {
  // Electron's protocol adapter does not always preserve Chromium's navigation request mode.
  const acceptsHtml = Option.exists(Option.fromNullishOr(request.headers.get('accept')), (value) =>
    value.includes('text/html'),
  )
  const path = yield* rendererAssetPath(
    root,
    url.pathname,
    request.mode === 'navigate' || acceptsHtml,
  )
  if (Option.isNone(path)) return new Response(null, { status: 403 })
  const bytes = yield* Effect.try({
    try: () => {
      const realRoot = NodeFS.realpathSync(root)
      const realFile = NodeFS.realpathSync(path.value)
      if (!realFile.startsWith(`${realRoot}${NodePath.sep}`)) return Option.none<Buffer>()
      return Option.some(NodeFS.readFileSync(realFile))
    },
    catch: () => new RendererAssetUnavailable({}),
  })
  if (Option.isNone(bytes)) return new Response(null, { status: 403 })
  const contentType = Option.getOrElse(
    Option.fromNullishOr(mediaTypes.get(NodePath.extname(path.value))),
    () => 'application/octet-stream',
  )
  const body = request.method === 'HEAD' ? null : new Uint8Array(bytes.value)
  return new Response(body, {
    headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
  })
})
