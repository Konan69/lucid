import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { RendererAssetUnavailable, rendererAssetPath, serveAsset } from './assets.ts'

/** Disposable files exercise the actual packaged-asset adapter without Electron or a server. */
const directory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-renderer-'))),
  (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
)

describe('packaged renderer assets', () => {
  it.effect('loads root and HTML routes when Electron omits the navigation mode', () =>
    Effect.gen(function* () {
      const root = yield* directory
      NodeFS.writeFileSync(NodePath.join(root, 'index.html'), '<title>Vivid</title>')
      for (const path of ['/', '/threads/123']) {
        const url = new URL(path, 'https://vivid.example')
        const response = yield* serveAsset(
          root,
          new Request(url, { headers: { accept: 'text/html' } }),
          url,
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.text())).toBe('<title>Vivid</title>')
      }
    }),
  )
  it.effect('serves bytes with the correct MIME type and preserves HEAD semantics', () =>
    Effect.gen(function* () {
      const root = yield* directory
      NodeFS.writeFileSync(NodePath.join(root, 'entry.js'), 'export const loaded = true')
      const url = new URL('https://vivid.example/entry.js')
      const response = yield* serveAsset(root, new Request(url), url)
      expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(yield* Effect.promise(() => response.text())).toBe('export const loaded = true')
      const head = yield* serveAsset(root, new Request(url, { method: 'HEAD' }), url)
      expect(head.body).toBeNull()
      const missing = new URL('https://vivid.example/missing.js')
      expect(yield* Effect.flip(serveAsset(root, new Request(missing), missing))).toBeInstanceOf(
        RendererAssetUnavailable,
      )
    }),
  )

  it.effect('maps document routes to the entry without hiding missing asset requests', () =>
    Effect.gen(function* () {
      const root = yield* directory
      expect(yield* rendererAssetPath(root, '/threads/123', true)).toEqual(
        Option.some(NodePath.join(root, 'index.html')),
      )
      expect(yield* rendererAssetPath(root, '/assets/missing.js', false)).toEqual(
        Option.some(NodePath.join(root, 'assets/missing.js')),
      )
    }),
  )

  it.effect('rejects encoded traversal, platform separators, and escaping symlinks', () =>
    Effect.gen(function* () {
      const parent = yield* directory
      const root = NodePath.join(parent, 'renderer')
      NodeFS.mkdirSync(root)
      NodeFS.writeFileSync(NodePath.join(parent, 'private.txt'), 'private')
      NodeFS.symlinkSync(NodePath.join(parent, 'private.txt'), NodePath.join(root, 'link.txt'))
      for (const path of ['/%2e%2e/private.txt', '/..%5cprivate.txt', '/%00']) {
        expect(Option.isNone(yield* rendererAssetPath(root, path, false))).toBe(true)
      }
      const url = new URL('https://vivid.example/link.txt')
      expect((yield* serveAsset(root, new Request(url), url)).status).toBe(403)
    }),
  )
})
