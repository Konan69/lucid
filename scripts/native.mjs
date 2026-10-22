import * as NodeAssert from 'node:assert/strict'
import * as NodePath from 'node:path'
import { createFileSystemWithLib } from 'tsc-rs/unstable/fs'

const libraries = createFileSystemWithLib([])
export const libraryDirectory = Object.keys(libraries.symlinks).find(NodePath.isAbsolute)
NodeAssert.notEqual(libraryDirectory, undefined, 'tsc-rs must expose its installed default library')
