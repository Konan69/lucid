import * as GitHub from 'alchemy/GitHub'
import * as Effect from 'effect/Effect'

/**
 * The Computer binaries' release, as infrastructure. The supervisor and its engine are never
 * committed (`apps/desktop/vendor/computer/README.md`); this release is where the desktop app's
 * build fetches them from, and managing it here is what makes that source one of the stack's
 * resources instead of a manual upload. The release body is the vendor README's proof surface:
 * anyone changing the pair bumps the tag and the hashes together, and Alchemy reconciles the
 * release that way on every deploy.
 *
 * The asset bytes are uploaded beside the release today (`gh release upload`), because the
 * pinned Alchemy beta has no release-asset resource. Their integrity is still owned by the
 * checksums in the vendor README, which `vendor/computer/fetch.sh` verifies before placing
 * anything, so a wrong or tampered asset can never reach the desktop app's build.
 */
export const computerBinariesRelease = Effect.fn('Infra.GitHub.computerBinaries')(function* () {
  return yield* GitHub.Release('computer-binaries', {
    owner: 'Konan69',
    repository: 'vivid',
    tagName: 'computer-v1',
    name: 'The Computer binaries (Windows)',
    body: [
      "The Windows Computer pair the desktop app fetches (`apps/desktop/vendor/computer/fetch.sh`):",
      '',
      '- `codex-computer-use.exe` — the supervisor, patched to Vivid: pill text, colors, and its',
      '  whole-computer allow policy',
      '- `swift/x64/codex-computer-use-swift.exe` beside it — the engine',
      '- `swift/x64/*.dll` — the engine\'s Microsoft runtime',
      '',
      'Every consumer verifies the sha256 recorded in `apps/desktop/vendor/computer/README.md`',
      'before placing anything; never trust a file that does not match.',
    ].join('\n'),
    targetCommitish: 'main',
  })
})
