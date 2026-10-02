import { describe, expect, it } from '@effect/vitest'
import { ShowRequest, Shown } from '@vivid/contracts'
import { Option, Schema } from 'effect'
import * as v from 'valibot'
import { showTools } from './show.ts'

/** Exercise every kind with its optional fields, including nested values the model must supply. */
const samples = {
  Table: Shown.cases.Table.make({
    title: 'Costs',
    columns: ['Item', 'Cost'],
    rows: [['Rent', '500 NGN']],
    note: '',
  }),
  Chart: Shown.cases.Chart.make({
    title: 'Sales',
    kind: 'line',
    labels: ['Jan', 'Feb'],
    series: [{ name: 'Sales', values: [12, 14] }],
    unit: ' NGN',
  }),
  Steps: Shown.cases.Steps.make({
    title: 'Plan',
    steps: [{ label: 'Review', state: 'doing', detail: 'Read the draft.' }],
  }),
  Options: Shown.cases.Options.make({
    question: 'Which day?',
    options: [{ label: 'Monday', detail: 'More time.' }, { label: 'Tuesday' }],
    many: false,
  }),
  Comparison: Shown.cases.Comparison.make({
    title: 'Plans',
    items: [
      {
        name: 'Basic',
        summary: '',
        good: ['Cheap'],
        bad: ['Limited'],
        facts: [{ label: 'Cost', value: '10 NGN' }],
      },
      { name: 'Pro', good: [], bad: [], facts: [] },
    ],
    pick: { name: 'Basic', why: 'It fits.' },
  }),
  Links: Shown.cases.Links.make({
    title: 'Sources',
    links: [{ title: 'Guide', address: 'https://example.test/guide', note: 'The source.' }],
  }),
  Facts: Shown.cases.Facts.make({
    title: 'Today',
    facts: [{ label: 'Sales', value: '12', change: '+2 today', tone: 'good' }],
  }),
  Draft: Shown.cases.Draft.make({
    kind: 'email',
    to: ['Ada'],
    subject: 'Review',
    body: 'Please review this.',
  }),
  Schedule: Shown.cases.Schedule.make({
    title: 'Today',
    day: 'Friday 3 October',
    items: [
      { at: '09:00', until: '10:00', title: 'Review', where: 'Office', note: 'Bring the draft.' },
    ],
  }),
  Form: Shown.cases.Form.make({
    title: 'Booking',
    fields: [{ label: 'Day', kind: 'choice', choices: ['Monday', 'Tuesday'], example: 'Monday' }],
    submit: 'Book it',
  }),
  Pictures: Shown.cases.Pictures.make({
    title: 'Examples',
    pictures: [{ address: 'https://example.test/picture.png', caption: 'The entrance.' }],
  }),
} satisfies { [Kind in Shown['_tag']]: Extract<Shown, { _tag: Kind }> }

const [show] = showTools()
const decodeRequest = Schema.decodeUnknownOption(ShowRequest)
/** Flue's public callback can return several envelopes; inspect the receipt as it reaches the model. */
const decodeReceipt = Schema.decodeUnknownSync(
  Schema.Struct({
    output: Schema.Struct({
      ok: Schema.Literal(true),
      shown: Schema.String,
      message: Schema.optionalKey(Schema.String),
    }),
    terminate: Schema.Boolean,
  }),
)
const context = {
  toolCallId: 'show-call',
  signal: new AbortController().signal,
  log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
}

/** Real model-input decoding and the registered Flue callback require no server authority or storage. */
describe('show tool', () => {
  it.each(Object.values(samples))('matches the surface contract for $_tag', (sample) => {
    const input = { show: sample }
    const parsed = v.safeParse(show.input, input)
    const decoded = decodeRequest(input)
    expect(parsed.success).toBe(true)
    expect(Option.isSome(decoded)).toBe(true)
    if (parsed.success && Option.isSome(decoded)) expect(parsed.output).toEqual(decoded.value)
  })

  it('matches absent optional fields across every kind', () => {
    const inputs = [
      Shown.cases.Table.make({ columns: ['Name'], rows: [] }),
      Shown.cases.Chart.make({
        kind: 'bar',
        labels: ['A'],
        series: [{ name: 'Count', values: [0] }],
      }),
      Shown.cases.Steps.make({ steps: [{ label: 'Review', state: 'to do' }] }),
      Shown.cases.Options.make({
        question: 'Which?',
        options: [{ label: 'A' }, { label: 'B' }],
        many: true,
      }),
      Shown.cases.Comparison.make({
        items: [
          { name: 'A', good: [], bad: [], facts: [] },
          { name: 'B', good: [], bad: [], facts: [] },
        ],
      }),
      Shown.cases.Links.make({ links: [{ title: 'Source', address: 'source' }] }),
      Shown.cases.Facts.make({ facts: [{ label: 'Count', value: '2' }] }),
      Shown.cases.Draft.make({ kind: 'document', to: [], body: 'Draft' }),
      Shown.cases.Schedule.make({ items: [{ at: '09:00', title: 'Review' }] }),
      Shown.cases.Form.make({
        title: 'Details',
        fields: [{ label: 'Name', kind: 'text', choices: [] }],
        submit: 'Save',
      }),
      Shown.cases.Pictures.make({ pictures: [{ address: 'picture' }] }),
    ]
    for (const sample of inputs) {
      const input = { show: sample }
      expect(v.safeParse(show.input, input).success).toBe(true)
      expect(Option.isSome(decodeRequest(input))).toBe(true)
    }
  })

  it.each([
    {
      name: 'maximum table size and text',
      value: {
        ...samples.Table,
        title: 'x'.repeat(200),
        columns: Array.from({ length: 8 }, () => 'Column'),
        rows: Array.from({ length: 60 }, () => Array.from({ length: 8 }, () => 'x'.repeat(2000))),
      },
    },
    { name: 'whitespace line', value: { ...samples.Table, title: ' ' } },
    { name: 'empty cell', value: { ...samples.Table, rows: [['']] } },
    { name: 'empty unit', value: { ...samples.Chart, unit: '' } },
    { name: 'maximum draft body', value: { ...samples.Draft, body: 'x'.repeat(20_000) } },
  ])('accepts $name identically', ({ value }) => {
    const input = { show: value }
    expect(v.safeParse(show.input, input).success).toBe(true)
    expect(Option.isSome(decodeRequest(input))).toBe(true)
  })

  it.each([
    {
      name: 'too many rows',
      value: { ...samples.Table, rows: Array.from({ length: 61 }, () => ['Row']) },
    },
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Invalid model input intentionally bypasses contract constructors.
    { name: 'unknown kind', value: { ...samples.Table, _tag: 'Unknown' } },
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Lowercase tags must fail the model and surface decoders alike.
    { name: 'lowercase kind', value: { ...samples.Table, _tag: 'table' } },
    { name: 'missing required field', value: { _tag: samples.Table._tag, columns: ['Name'] } },
    { name: 'empty columns', value: { ...samples.Table, columns: [] } },
    {
      name: 'too many columns',
      value: { ...samples.Table, columns: Array.from({ length: 9 }, () => 'Column') },
    },
    {
      name: 'too many cells',
      value: { ...samples.Table, rows: [Array.from({ length: 9 }, () => 'Cell')] },
    },
    { name: 'overlong cell', value: { ...samples.Table, rows: [['x'.repeat(2001)]] } },
    { name: 'empty title', value: { ...samples.Table, title: '' } },
    { name: 'overlong title', value: { ...samples.Table, title: 'x'.repeat(201) } },
    { name: 'undefined optional key', value: { ...samples.Table, title: undefined } },
    { name: 'null optional key', value: { ...samples.Table, note: null } },
    { name: 'unknown chart style', value: { ...samples.Chart, kind: 'pie' } },
    { name: 'empty labels', value: { ...samples.Chart, labels: [] } },
    {
      name: 'too many labels',
      value: { ...samples.Chart, labels: Array.from({ length: 61 }, () => 'Label') },
    },
    { name: 'empty series', value: { ...samples.Chart, series: [] } },
    {
      name: 'too many series',
      value: {
        ...samples.Chart,
        series: Array.from({ length: 7 }, () => ({ name: 'Series', values: [1] })),
      },
    },
    { name: 'empty values', value: { ...samples.Chart, series: [{ name: 'Series', values: [] }] } },
    {
      name: 'too many values',
      value: {
        ...samples.Chart,
        series: [{ name: 'Series', values: Array.from({ length: 61 }, () => 1) }],
      },
    },
    {
      name: 'infinite value',
      value: { ...samples.Chart, series: [{ name: 'Series', values: [Infinity] }] },
    },
    { name: 'NaN value', value: { ...samples.Chart, series: [{ name: 'Series', values: [NaN] }] } },
    { name: 'overlong unit', value: { ...samples.Chart, unit: 'x'.repeat(13) } },
    { name: 'empty steps', value: { ...samples.Steps, steps: [] } },
    {
      name: 'too many steps',
      value: {
        ...samples.Steps,
        steps: Array.from({ length: 31 }, () => ({ label: 'Step', state: 'done' })),
      },
    },
    {
      name: 'unknown step state',
      value: { ...samples.Steps, steps: [{ label: 'Step', state: 'pending' }] },
    },
    { name: 'too few options', value: { ...samples.Options, options: [{ label: 'Only one' }] } },
    {
      name: 'too many options',
      value: {
        ...samples.Options,
        options: Array.from({ length: 9 }, () => ({ label: 'Option' })),
      },
    },
    {
      name: 'missing choice mode',
      value: { _tag: samples.Options._tag, question: 'Which?', options: samples.Options.options },
    },
    { name: 'too few comparison items', value: { ...samples.Comparison, items: [] } },
    {
      name: 'too many comparison items',
      value: {
        ...samples.Comparison,
        items: Array.from({ length: 6 }, () => ({ name: 'Item', good: [], bad: [], facts: [] })),
      },
    },
    {
      name: 'too many advantages',
      value: {
        ...samples.Comparison,
        items: [
          { name: 'A', good: Array.from({ length: 7 }, () => 'Good'), bad: [], facts: [] },
          { name: 'B', good: [], bad: [], facts: [] },
        ],
      },
    },
    {
      name: 'too many drawbacks',
      value: {
        ...samples.Comparison,
        items: [
          { name: 'A', good: [], bad: Array.from({ length: 7 }, () => 'Bad'), facts: [] },
          { name: 'B', good: [], bad: [], facts: [] },
        ],
      },
    },
    {
      name: 'too many comparison facts',
      value: {
        ...samples.Comparison,
        items: [
          {
            name: 'A',
            good: [],
            bad: [],
            facts: Array.from({ length: 9 }, () => ({ label: 'Fact', value: 'Value' })),
          },
          { name: 'B', good: [], bad: [], facts: [] },
        ],
      },
    },
    { name: 'empty links', value: { ...samples.Links, links: [] } },
    {
      name: 'too many links',
      value: {
        ...samples.Links,
        links: Array.from({ length: 13 }, () => ({ title: 'Link', address: 'source' })),
      },
    },
    {
      name: 'empty address',
      value: { ...samples.Links, links: [{ title: 'Source', address: '' }] },
    },
    {
      name: 'overlong address',
      value: { ...samples.Links, links: [{ title: 'Source', address: 'x'.repeat(2001) }] },
    },
    { name: 'empty facts', value: { ...samples.Facts, facts: [] } },
    {
      name: 'too many facts',
      value: {
        ...samples.Facts,
        facts: Array.from({ length: 9 }, () => ({ label: 'Fact', value: 'Value' })),
      },
    },
    {
      name: 'unknown fact tone',
      value: { ...samples.Facts, facts: [{ label: 'Count', value: '2', tone: 'neutral' }] },
    },
    { name: 'empty draft', value: { ...samples.Draft, body: '' } },
    { name: 'overlong draft', value: { ...samples.Draft, body: 'x'.repeat(20_001) } },
    {
      name: 'too many recipients',
      value: { ...samples.Draft, to: Array.from({ length: 21 }, () => 'Ada') },
    },
    { name: 'unknown draft kind', value: { ...samples.Draft, kind: 'letter' } },
    { name: 'empty schedule', value: { ...samples.Schedule, items: [] } },
    {
      name: 'too many events',
      value: {
        ...samples.Schedule,
        items: Array.from({ length: 31 }, () => ({ at: '09:00', title: 'Event' })),
      },
    },
    { name: 'empty form', value: { ...samples.Form, fields: [] } },
    {
      name: 'too many fields',
      value: {
        ...samples.Form,
        fields: Array.from({ length: 11 }, () => ({ label: 'Name', kind: 'text', choices: [] })),
      },
    },
    {
      name: 'unknown field kind',
      value: { ...samples.Form, fields: [{ label: 'Name', kind: 'password', choices: [] }] },
    },
    {
      name: 'missing choices',
      value: { ...samples.Form, fields: [{ label: 'Name', kind: 'text' }] },
    },
    {
      name: 'too many field choices',
      value: {
        ...samples.Form,
        fields: [
          { label: 'Name', kind: 'choice', choices: Array.from({ length: 13 }, () => 'Choice') },
        ],
      },
    },
    { name: 'empty pictures', value: { ...samples.Pictures, pictures: [] } },
    {
      name: 'too many pictures',
      value: {
        ...samples.Pictures,
        pictures: Array.from({ length: 13 }, () => ({ address: 'picture' })),
      },
    },
  ])('rejects $name identically', ({ value }) => {
    const input = { show: value }
    expect(v.safeParse(show.input, input).success).toBe(false)
    expect(Option.isSome(decodeRequest(input))).toBe(false)
  })

  it.each([samples.Options, samples.Form, samples.Draft])(
    'terminates $_tag for the Person to answer',
    async (sample) => {
      const result = decodeReceipt(
        await show.run({ ...context, data: v.parse(show.input, { show: sample }) }),
      )
      expect(result.terminate).toBe(true)
      expect(result.output).toMatchObject({ ok: true, shown: sample._tag.toLowerCase() })
      expect(result.output.message).toContain('The Person will answer in their next message.')
      expect(result.output).not.toHaveProperty('show')
    },
  )

  it('acknowledges Table without terminating or duplicating its display', async () => {
    const result = decodeReceipt(
      await show.run({ ...context, data: v.parse(show.input, { show: samples.Table }) }),
    )
    expect(result).toEqual({ output: { ok: true, shown: 'table' }, terminate: false })
  })
})
