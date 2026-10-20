import {
  Company,
  CompanyId,
  LibraryFolderId,
  LibraryItemId,
  Workspace,
  type LibraryFolder,
  type LibraryItem,
} from '@vivid/contracts'
import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  inFolder,
  itemMoved,
  itemRemoved,
  itemRenamed,
  shelvesOf,
  uploadOutcome,
} from './library.js'

const NOW = Date.UTC(2026, 9, 1, 12)

/** A ready text file at the top of the Person's own shelf, changed per test. */
const item = (id: string, changes: Partial<LibraryItem>): LibraryItem => ({
  id: LibraryItemId.make(id),
  name: `${id}.txt`,
  mimeType: 'text/plain',
  size: 12,
  sha256: id,
  status: 'ready',
  error: null,
  preview: 'Hello',
  chunkCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  folderId: null,
  shelf: 'Mine',
  ...changes,
})

const folder = (id: string, parentId: string | null): LibraryFolder => ({
  id: LibraryFolderId.make(id),
  name: id,
  parentId: parentId === null ? null : LibraryFolderId.make(parentId),
  createdAt: NOW,
  updatedAt: NOW,
  itemCount: 0,
  shelf: 'Mine',
})

describe('shelvesOf', () => {
  it('offers one shelf, simply the Library, in a personal space', () => {
    expect(shelvesOf(Workspace.cases.Personal.make({}))).toEqual([
      { shelf: 'Mine', name: 'Library' },
    ])
  })

  it("offers the Person's shelf and the Company's, by the Company's name", () => {
    const company = new Company({ id: CompanyId.make('acme'), name: 'Acme', slug: 'acme' })
    expect(shelvesOf(Workspace.cases.Company.make({ company, role: 'member' }))).toEqual([
      { shelf: 'Mine', name: 'Mine' },
      { shelf: 'Company', name: 'Acme' },
    ])
  })
})

describe('inFolder', () => {
  const contracts = LibraryFolderId.make('contracts')
  const invoices = LibraryFolderId.make('invoices')
  const year = LibraryFolderId.make('2026')
  // One shelf's whole result, every level at once, as the server lists it.
  const shelf = {
    documents: [
      item('top', {}),
      item('filed', { folderId: contracts }),
      item('elsewhere', { folderId: invoices }),
      item('deeper', { folderId: year }),
    ],
    folders: [folder('contracts', null), folder('invoices', null), folder('2026', 'contracts')],
  }

  it('shows only what is filed at the top of a shelf whose result lists every item', () => {
    const top = inFolder(shelf, null)
    expect(top.documents.map((each) => each.id)).toEqual(['top'])
    expect(top.folders.map((each) => each.id)).toEqual(['contracts', 'invoices'])
  })

  it('shows a folder its own items and the folders directly inside it', () => {
    // Not the top's, not a sibling folder's, and not what is filed one level further down.
    const inside = inFolder(shelf, contracts)
    expect(inside.documents.map((each) => each.id)).toEqual(['filed'])
    expect(inside.folders.map((each) => each.id)).toEqual(['2026'])
    const sibling = inFolder(shelf, invoices)
    expect(sibling.documents.map((each) => each.id)).toEqual(['elsewhere'])
    expect(sibling.folders).toEqual([])
  })
})

describe('uploadOutcome', () => {
  const body = JSON.stringify({ document: item('a', {}), duplicate: false })

  it('reads an accepted upload and whether the shelf already had those bytes', () => {
    const fresh = uploadOutcome(201, body)
    expect(Result.isSuccess(fresh) && fresh.success.duplicate).toBe(false)
    const again = uploadOutcome(200, JSON.stringify({ document: item('a', {}), duplicate: true }))
    expect(Result.isSuccess(again) && again.success.duplicate).toBe(true)
    expect(Result.isSuccess(again) && again.success.item.name).toBe('a.txt')
  })

  it("keeps the server's sentence when it refuses", () => {
    const refused = uploadOutcome(403, JSON.stringify({ error: 'Library access denied' }))
    expect(Result.isFailure(refused) && refused.failure.message).toBe('Library access denied')
  })

  it('refuses a body that is not the upload contract, whatever the status says', () => {
    const wrong = uploadOutcome(200, '<html>proxy error</html>')
    expect(Result.isFailure(wrong) && wrong.failure.message).toBe(
      'The upload did not go through (200).',
    )
    const empty = uploadOutcome(502, '')
    expect(Result.isFailure(empty) && empty.failure.message).toBe(
      'The upload did not go through (502).',
    )
  })
})

describe('expectations', () => {
  const contracts = LibraryFolderId.make('contracts')
  const shelf = { documents: [item('a', {}), item('b', {})], folders: [folder('contracts', null)] }

  it('renames one item and leaves the rest of the shelf alone', () => {
    const next = itemRenamed(LibraryItemId.make('a'), 'Terms.txt')(shelf)
    expect(next.documents.map((each) => each.name)).toEqual(['Terms.txt', 'b.txt'])
    expect(next.folders).toBe(shelf.folders)
  })

  it('takes a moved item out of the level it left', () => {
    const next = itemMoved(LibraryItemId.make('a'), contracts)(shelf)
    expect(inFolder(next, null).documents.map((each) => each.id)).toEqual(['b'])
    expect(inFolder(next, contracts).documents.map((each) => each.id)).toEqual(['a'])
  })

  it('removes a deleted item', () => {
    const next = itemRemoved(LibraryItemId.make('b'))(shelf)
    expect(next.documents.map((each) => each.id)).toEqual(['a'])
  })
})
