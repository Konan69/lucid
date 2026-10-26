# Packed dependencies

Packages the phone app installs from a file in this directory, because the build it needs is not
on the registry.

## `react-native-enriched-markdown-1.2.0-t3.16-558767d9.tgz`

The native Markdown renderer behind `src/ui/Prose.tsx`: it draws Markdown in the platform's own
text views, so text is selectable, and it fades in the words a reply gains while it is being
written (`streamingAnimation`).

- **What it is:** Software Mansion's `react-native-enriched-markdown`, in the build T3 Code's
  phone app uses.
- **Source:** the `fork/t3-mobile` branch of `github.com/pingdotgg/enriched-markdown`. The
  package's own `t3-fork.json` records the commit it was packed from
  (`558767d9bccec81805d960f792ab0fcda7c1e7c8`) and the upstream commit that is its base
  (`69c3330dd6d75cacd8d046f4e0c4b8fe5c42a6e1`).
- **Version:** `1.2.0-t3.16`. The file is the one T3 Code ships, byte for byte (sha256
  `d9b75931bafb1847172550bb4eaafb7b8f59632a79b796e6174a93261e95c0fd`).
- **Licence:** MIT, copyright Software Mansion. The licence text is `LICENSE` inside the package.

It is native code: a Fabric view, so it needs React Native's new architecture, and a phone only
has it after a new build of the app. Its optional parts are set in `apps/mobile/package.json`
(`enriched-markdown`) as T3 Code sets them: the maths renderer on, the video player off, and
syntax colouring of code on (its default). The install step downloads the grammar sources (about
170 MB) and the maths renderer's source, so `pnpm-workspace.yaml` allows it to run. The server
image's over-the-air export installs with `--ignore-scripts` (`apps/server/Dockerfile`): it
builds JavaScript only. Until 26 October 2026 code colouring was switched off here, which is why
code blocks were one colour.

An install reads this file, so it must be present wherever `pnpm install` resolves the phone
app's dependencies: an image build has to copy this directory in beside
`apps/mobile/package.json` before it installs.

To replace it, pack the fork (`node scripts/pack-t3.mjs <this directory>` in a checkout of it, after
its own `prepare`), raise the fork's version so the file has a new name, and change that name in
`apps/mobile/package.json` and in `allowBuilds` in `pnpm-workspace.yaml`. Then run `pnpm install`
and build the app again: a change here is a change to the native side
(`apps/mobile/README.md`, "Over-the-air updates").
