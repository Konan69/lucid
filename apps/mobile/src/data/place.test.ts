import { LibraryFolderId, ProjectId, ThreadId } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  decodePlaces,
  encodePlaces,
  NOWHERE,
  pageOf,
  placeAt,
  withPlace,
  type Place,
} from './place.ts'

const thread = ThreadId.make('2f0c1a54-1f4e-4c0e-9a39-0d6f3d1f7a11')
const inProject: Place = {
  thread: Option.some(thread),
  pages: [
    { name: 'Projects' },
    { name: 'Project', params: { id: ProjectId.make('7a9d2c33-6b1e-4f52-8c44-21e5a0b9c7de') } },
  ],
}

describe('where the Person was', () => {
  it('comes back from the file as it was kept: the Thread in front and the pages over it', () => {
    const kept = withPlace({}, 'https://vivid.example', 'personal', inProject)
    const text = Option.getOrThrow(encodePlaces(kept))
    const read = Option.getOrThrow(decodePlaces(text))
    expect(placeAt(read, 'https://vivid.example', 'personal')).toEqual(inProject)
  })

  it('is the greeting for a workspace nothing was kept for', () => {
    const kept = withPlace({}, 'https://vivid.example', 'personal', inProject)
    expect(placeAt(kept, 'https://vivid.example', 'company-1')).toEqual(NOWHERE)
  })

  it('keeps each workspace its own place on one server', () => {
    const one = withPlace({}, 'https://vivid.example', 'personal', inProject)
    const two = withPlace(one, 'https://vivid.example', 'company-1', NOWHERE)
    expect(placeAt(two, 'https://vivid.example', 'personal')).toEqual(inProject)
    expect(placeAt(two, 'https://vivid.example', 'company-1')).toEqual(NOWHERE)
  })

  it('drops what was kept for another server once this one keeps a place', () => {
    const old = withPlace({}, 'https://old.example', 'personal', inProject)
    const now = withPlace(old, 'https://vivid.example', 'personal', NOWHERE)
    expect(placeAt(now, 'https://old.example', 'personal')).toEqual(NOWHERE)
  })

  it('reads text in a shape it does not know as nothing kept', () => {
    expect(Option.isNone(decodePlaces('{"https://vivid.example":{"personal":{"thread":7}}}'))).toBe(
      true,
    )
    expect(Option.isNone(decodePlaces('not json'))).toBe(true)
  })
})

describe('a page that can be drawn again', () => {
  it('is a place with no parameters, by its name alone', () => {
    expect(pageOf({ name: 'Library', params: undefined })).toEqual(Option.some({ name: 'Library' }))
  })

  it('carries what a folder was opened with', () => {
    const params = { shelf: 'Mine', id: LibraryFolderId.make('folder-1'), name: 'Receipts' }
    expect(pageOf({ name: 'Folder', params })).toEqual(Option.some({ name: 'Folder', params }))
  })

  it('is not a bottom sheet, which is a step in something the Person was doing', () => {
    expect(Option.isNone(pageOf({ name: 'Account', params: { id: 'connection-1' } }))).toBe(true)
    expect(Option.isNone(pageOf({ name: 'Home' }))).toBe(true)
  })
})
