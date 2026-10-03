import { Shown } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  CHART,
  chartScale,
  chartShares,
  chartValue,
  comparisonOrder,
  draftIsLong,
  formReply,
  readShown,
  rowCells,
  siteOf,
  togglePicked,
} from './shown'

/** Charts may have missing cells; both surfaces must retain their labels without NaN geometry. */
const share = Shown.cases.Chart.make({
  kind: 'share',
  labels: ['Rent', 'Food', 'Refund', 'Other'],
  series: [{ name: 'Budget', values: [300, 100, -20] }],
})

describe('display data shared by web and mobile', () => {
  it('reads show input before a tool result exists and rejects incomplete model output', () => {
    expect(
      readShown({
        show: {
          // This is untrusted model output, deliberately not a schema construction.
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction
          _tag: 'Options',
          question: 'Which?',
          options: [{ label: 'A' }, { label: 'B' }],
          many: true,
        },
      }),
    ).toEqual(
      Option.some({
        show: Shown.cases.Options.make({
          question: 'Which?',
          options: [{ label: 'A' }, { label: 'B' }],
          many: true,
        }),
      }),
    )
    // Malformed external payloads cannot be constructed with the contract's make.
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction
    expect(readShown({ show: { _tag: 'Options', question: 'Which?' } })).toEqual(Option.none())
    // An unknown external kind must be rejected at ingress.
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction
    expect(readShown({ show: { _tag: 'Markup', html: '<button>Send</button>' } })).toEqual(
      Option.none(),
    )
  })

  it('computes first-series shares, ignoring negative parts and preserving missing labels', () => {
    expect(chartShares(share)).toEqual([
      { label: 'Rent', value: 300, share: 0.75, from: 0 },
      { label: 'Food', value: 100, share: 0.25, from: 0.75 },
      { label: 'Refund', value: 0, share: 0, from: 1 },
      { label: 'Other', value: 0, share: 0, from: 1 },
    ])
    expect(
      chartShares(
        Shown.cases.Chart.make({
          kind: 'share',
          labels: ['None'],
          series: [
            { name: 'First', values: [-1] },
            { name: 'Ignored', values: [90] },
          ],
        }),
      ),
    ).toEqual([{ label: 'None', value: 0, share: 0, from: 0 }])
  })

  it('places negative values below zero and avoids division by zero on empty movement', () => {
    const mixed = chartScale(
      Shown.cases.Chart.make({
        kind: 'bar',
        labels: ['A', 'B'],
        series: [{ name: 'Change', values: [-10, 30] }],
      }),
      CHART,
    )
    expect(mixed.y(30)).toBe(12)
    expect(mixed.y(0)).toBe(162)
    expect(mixed.y(-10)).toBe(212)
    const zero = chartScale(
      Shown.cases.Chart.make({
        kind: 'line',
        labels: ['A'],
        series: [{ name: 'Change', values: [0] }],
      }),
      CHART,
    )
    expect(zero.y(0)).toBe(12)
    expect(zero.slot).toBe(624)
    expect(chartValue(1.236, ' hrs')).toBe('1.24 hrs')
  })

  it('says filled form fields in order with whitespace removed and blank fields omitted', () => {
    expect(
      formReply([
        { label: 'Name', value: ' Ada ' },
        { label: 'Note', value: ' \n ' },
        { label: 'When', value: '2026-10-03' },
      ]),
    ).toBe('Name: Ada\nWhen: 2026-10-03')
    expect(formReply([{ label: 'Name', value: '' }])).toBe('')
  })

  it('shows sites without www and preserves addresses that are not URLs', () => {
    expect(siteOf('https://www.example.com/path?q=1')).toBe('example.com')
    expect(siteOf('https://docs.example.com/path')).toBe('docs.example.com')
    expect(siteOf('not an address')).toBe('not an address')
  })

  it('keeps multiple-choice answers in selection order across unpicking and re-picking', () => {
    const first = togglePicked([], 'B')
    const second = togglePicked(first, 'A')
    expect(second.join(', ')).toBe('B, A')
    expect(togglePicked(second, 'B')).toEqual(['A'])
    expect(togglePicked(togglePicked(second, 'B'), 'B')).toEqual(['A', 'B'])
    expect(second).toEqual(['B', 'A'])
  })

  it('pages the recommendation first without rewriting alternatives or their remaining order', () => {
    const comparison = Shown.cases.Comparison.make({
      items: [
        { name: 'A', good: ['Fast'], bad: [], facts: [] },
        { name: 'B', good: [], bad: ['Cost'], facts: [] },
        { name: 'C', good: ['Fits'], bad: [], facts: [] },
      ],
      pick: { name: 'C', why: 'Fits the work.' },
    })
    expect(comparisonOrder(comparison).map((item) => item.name)).toEqual(['C', 'A', 'B'])
    expect(comparisonOrder(comparison)[0]).toBe(comparison.items[2])
    expect(comparison.items.map((item) => item.name)).toEqual(['A', 'B', 'C'])
    expect(comparisonOrder(Shown.cases.Comparison.make({ items: comparison.items }))).toEqual(
      comparison.items,
    )
  })

  it('separates long drafts for reading while retaining all of a short body', () => {
    expect(draftIsLong('A short reply.')).toBe(false)
    expect(draftIsLong('x'.repeat(321))).toBe(true)
    expect(draftIsLong('One\nTwo\nThree\nFour\nFive\nSix\nSeven')).toBe(true)
  })

  it('uses phone drawing units without changing the numbers or direction of the scale', () => {
    const chart = Shown.cases.Chart.make({
      kind: 'line',
      labels: ['A', 'B'],
      series: [{ name: 'Change', values: [-10, 30] }],
    })
    const drawing = { width: 320, height: 200, left: 8, right: 8, top: 22, bottom: 32 }
    const scale = chartScale(chart, drawing)
    expect(scale.y(30)).toBe(22)
    expect(scale.y(-10)).toBe(168)
    expect(scale.y(0)).toBeGreaterThan(scale.y(30))
    expect(scale.y(0)).toBeLessThan(scale.y(-10))
    expect(scale.slot).toBe(152)
  })
})

describe('table rows on a phone', () => {
  it('pads a short row and drops cells past the last column', () => {
    expect(rowCells(['A'], 3)).toEqual(['A', '', ''])
    expect(rowCells(['A', 'B', 'C'], 2)).toEqual(['A', 'B'])
  })
})
