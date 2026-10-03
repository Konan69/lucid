import { describe, expect, it } from 'vitest'
import { fieldName, fieldsOf, Shown, shownAs } from './action.ts'

describe('the fields of an action', () => {
  it('keeps every field, in the order it was written, under its own key', () => {
    const input = { to: 'dami@northwind.example', reply_to: 'ada@northwind.example', body: 'Hi' }
    expect(fieldsOf(input).map(([key]) => key)).toEqual(['to', 'reply_to', 'body'])
  })

  it('shows an input that is not a set of fields as one field, whole', () => {
    expect(fieldsOf(['a', 'b'])).toEqual([['details', ['a', 'b']]])
    expect(fieldsOf('rm -rf build')).toEqual([['details', 'rm -rf build']])
  })

  it('reads two differently written keys the same way, which is why the key is shown too', () => {
    expect(fieldName('reply_to')).toBe('Reply to')
    expect(fieldName('replyTo')).toBe('Reply to')
    const keys = fieldsOf({ reply_to: 'ada', replyTo: 'ben' }).map(([key]) => key)
    expect(keys).toEqual(['reply_to', 'replyTo'])
  })
})

describe('how a value is shown', () => {
  it('does not let the word "false" pass for the value false', () => {
    expect(shownAs('false')).toEqual(Shown.Text({ text: 'false' }))
    expect(shownAs(false)).toEqual(Shown.Literal({ text: 'false' }))
    expect(shownAs(null)).toEqual(Shown.Literal({ text: 'null' }))
    expect(shownAs(3)).toEqual(Shown.Literal({ text: '3' }))
  })

  it('keeps where one item of a list ends and the next begins', () => {
    // Joined with commas these two read the same; as items they do not.
    expect(shownAs(['finance, external', 'legal'])).toEqual(
      Shown.List({ items: ['finance, external', 'legal'] }),
    )
    expect(shownAs(['finance', 'external, legal'])).toEqual(
      Shown.List({ items: ['finance', 'external, legal'] }),
    )
  })

  it('tells empty text, an empty list and nothing apart', () => {
    const shown = [shownAs(''), shownAs([]), shownAs(null)]
    expect(shown).toEqual([
      Shown.Literal({ text: '""' }),
      Shown.Literal({ text: '[]' }),
      Shown.Literal({ text: 'null' }),
    ])
  })

  it('shows something nested whole', () => {
    expect(shownAs({ amount: 1200, currency: 'NGN' })).toEqual(
      Shown.Literal({ text: '{\n  "amount": 1200,\n  "currency": "NGN"\n}' }),
    )
  })
})
