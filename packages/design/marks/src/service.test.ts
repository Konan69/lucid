import { describe, expect, it } from 'vitest'
import { figureKey } from './figure.js'
import { SERVICE_MARKS, SERVICE_MARK_IDS, isServiceMarkId } from './service.js'

describe('service marks', () => {
  /**
   * Both renderers key a mark's figures by content. Two figures with the same key inside one mark
   * would make React drop one of them, so the artwork would silently lose a layer.
   */
  it('gives every figure of a mark a distinct key', () => {
    for (const id of SERVICE_MARK_IDS) {
      const keys = SERVICE_MARKS[id].figures.map(figureKey)
      expect(new Set(keys).size, `${id} has colliding figure keys`).toBe(keys.length)
    }
  })

  it('narrows only identifiers Vivid has drawn', () => {
    expect(isServiceMarkId('gmail')).toBe(true)
    expect(isServiceMarkId('slack')).toBe(false)
    // A prototype-chain name must not pass as a drawn service.
    expect(isServiceMarkId('toString')).toBe(false)
  })
})
