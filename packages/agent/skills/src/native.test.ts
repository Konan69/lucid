import * as NodeFS from 'node:fs'
import { describe, expect, it } from '@effect/vitest'
import { Array as Arr, Order } from 'effect'
import { manifest } from './manifest.ts'
import { nativeSkills, nativeSkillsInOrder } from './native.ts'

describe('native built-in mounts', () => {
  it('has exactly the manifest folders, keys and correctly named packaged imports', () => {
    const root = new URL('../', import.meta.url)
    const folders = NodeFS.readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && NodeFS.existsSync(new URL(`${entry.name}/SKILL.md`, root)),
      )
      .map((entry) => entry.name)
    expect(Arr.sort(folders, Order.String)).toEqual(
      Arr.sort(
        manifest.map((entry) => entry.runtimeName),
        Order.String,
      ),
    )
    expect(Object.keys(nativeSkills)).toEqual(manifest.map((entry) => entry.runtimeName))
    for (const entry of manifest)
      expect(nativeSkills[entry.runtimeName].name).toBe(entry.runtimeName)
    expect(nativeSkillsInOrder.map((skill) => skill.name)).toEqual(
      manifest.map((entry) => entry.runtimeName),
    )
  })
})
