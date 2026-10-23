# Packed dependencies

Packages the phone app installs from a file in this directory, because the build it needs is not
on the registry.

## `react-native-enriched-markdown-1.2.0-t3.11.tgz`

The native Markdown renderer behind `src/ui/Prose.tsx`: it draws Markdown in the platform's own
text views, so text is selectable, and it fades in the words a reply gains while it is being
written (`streamingAnimation`).

- **What it is:** Software Mansion's `react-native-enriched-markdown`, in the build T3 Code's
  phone app uses.
- **Source:** the `fork/t3-mobile` branch of `github.com/pingdotgg/enriched-markdown`. The
  package's own `t3-fork.json` records the commit it was packed from
  (`3824d119a1ed6206f51ba3ec8ddf9ff93b8852f9`) and the upstream commit that is its base
  (`9684fdf425d3aa86825b69c8f65a5dedb03630bf`).
- **Version:** `1.2.0-t3.11`. The file is the one T3 Code ships, byte for byte (sha256
  `29c0867f3d0ecae90b3cf4cd6d0f029ad1e860fcd7cd7dcdb843480818690b0e`).
- **Licence:** MIT, copyright Software Mansion. The licence text is `LICENSE` inside the package.

It is native code: a Fabric view, so it needs React Native's new architecture, and a phone only
has it after a new build of the app. Its three optional parts are switched off in
`apps/mobile/package.json` (`enriched-markdown`): the maths renderer and the video player, as in
T3 Code, and syntax colouring of code, which T3 Code keeps. Syntax colouring is the one part whose
sources are not in the package: its install step downloads about 170 MB of grammar sources, and
Vivid's themes have no colours for it yet. With all three off the install step has nothing to do,
so `pnpm-workspace.yaml` does not run it.

An install reads this file, so it must be present wherever `pnpm install` resolves the phone
app's dependencies: an image build has to copy this directory in beside
`apps/mobile/package.json` before it installs.

To replace it, pack the fork (`node scripts/pack-t3.mjs <this directory>` in a checkout of it, after
its own `prepare`), raise the fork's version so the file has a new name, and change that name in
`apps/mobile/package.json` and in `allowBuilds` in `pnpm-workspace.yaml`. Then run `pnpm install`
and build the app again: a change here is a change to the native side
(`apps/mobile/README.md`, "Over-the-air updates").
