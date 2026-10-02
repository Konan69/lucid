import { Schema } from 'effect'

/**
 * What Vivid shows in a Thread when words alone are the wrong shape for the answer: a table, a
 * chart, the steps of a plan, choices to pick from, a comparison, a draft to send.
 *
 * Vivid asks for one with its `show` tool, and the request IS the thing shown: every surface
 * decodes the tool's input with this schema and draws it, so there is no second copy of the data
 * on a server and nothing to keep in step. It follows the "client tools" of AG-UI and the display
 * renderers of the assistants Vivid was compared against, with one difference: the kinds are a
 * closed list that each surface draws natively, never markup the model wrote.
 *
 * Three kinds take something back from the Person (`Options`, `Form`, and a `Draft`'s actions).
 * What they choose is said as their next message in the Thread, in plain words, so the
 * conversation reads the same to someone who was not looking at the card.
 *
 * Everything here is bounded, because it is model output drawn on a screen.
 */

const Line = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200))
const Words = Schema.String.check(Schema.isMaxLength(2000))
const Title = Schema.optionalKey(Line)

const Table = {
  title: Title,
  columns: Schema.Array(Line).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  /** Each row has one cell per column, as text. Numbers are written the way they should read. */
  rows: Schema.Array(Schema.Array(Words).check(Schema.isMaxLength(8))).check(
    Schema.isMaxLength(60),
  ),
  note: Schema.optionalKey(Words),
}

/** One named run of values. Every series of a chart shares the same labels, in order. */
const Series = Schema.Struct({
  name: Line,
  values: Schema.Array(Schema.Finite).check(Schema.isMinLength(1), Schema.isMaxLength(60)),
})

const Chart = {
  title: Title,
  /** A bar compares, a line shows change over time, a share shows parts of one whole. */
  kind: Schema.Literals(['bar', 'line', 'share'] as const),
  /** What runs along the bottom, or names each part: "Jan", "Feb", "Rent". */
  labels: Schema.Array(Line).check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  series: Schema.Array(Series).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  /** Said after each value: "%", " hrs", " NGN". */
  unit: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(12))),
}

const Steps = {
  title: Title,
  steps: Schema.Array(
    Schema.Struct({
      label: Line,
      state: Schema.Literals(['to do', 'doing', 'done', 'skipped'] as const),
      detail: Schema.optionalKey(Words),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
}

const Options = {
  question: Line,
  options: Schema.Array(Schema.Struct({ label: Line, detail: Schema.optionalKey(Words) })).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(8),
  ),
  /** Whether more than one may be picked. */
  many: Schema.Boolean,
}

const Comparison = {
  title: Title,
  items: Schema.Array(
    Schema.Struct({
      name: Line,
      summary: Schema.optionalKey(Words),
      good: Schema.Array(Line).check(Schema.isMaxLength(6)),
      bad: Schema.Array(Line).check(Schema.isMaxLength(6)),
      facts: Schema.Array(Schema.Struct({ label: Line, value: Line })).check(Schema.isMaxLength(8)),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(5)),
  /** The one Vivid would pick, by name, and why in a sentence. Absent when it would not pick. */
  pick: Schema.optionalKey(Schema.Struct({ name: Line, why: Words })),
}

const Links = {
  title: Title,
  links: Schema.Array(
    Schema.Struct({
      title: Line,
      address: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
      /** Why this one is worth opening, in a sentence. */
      note: Schema.optionalKey(Words),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
}

const Facts = {
  title: Title,
  facts: Schema.Array(
    Schema.Struct({
      label: Line,
      value: Line,
      /** How it moved, said as it should read: "+12% this week". */
      change: Schema.optionalKey(Line),
      /** Whether that movement is good or bad for the Person, when it is one or the other. */
      tone: Schema.optionalKey(Schema.Literals(['good', 'bad'] as const)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
}

const Draft = {
  /** What is drafted. It decides the words on the card, never where it is sent. */
  kind: Schema.Literals(['email', 'message', 'post', 'document'] as const),
  to: Schema.Array(Line).check(Schema.isMaxLength(20)),
  subject: Schema.optionalKey(Line),
  body: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(20_000)),
}

const Schedule = {
  title: Title,
  /** The day it is for, written out: "Friday 3 October". */
  day: Schema.optionalKey(Line),
  items: Schema.Array(
    Schema.Struct({
      /** When, as it should read: "09:00", "2:30 PM", "All day". */
      at: Line,
      until: Schema.optionalKey(Line),
      title: Line,
      where: Schema.optionalKey(Line),
      note: Schema.optionalKey(Words),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
}

const Form = {
  title: Line,
  fields: Schema.Array(
    Schema.Struct({
      label: Line,
      kind: Schema.Literals(['text', 'long text', 'number', 'date', 'choice'] as const),
      /** The choices of a `choice` field. Ignored for the other kinds. */
      choices: Schema.Array(Line).check(Schema.isMaxLength(12)),
      /** Shown inside the empty field as an example. */
      example: Schema.optionalKey(Line),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  /** What the button says: "Book it", "Save". */
  submit: Line,
}

const Pictures = {
  title: Title,
  pictures: Schema.Array(
    Schema.Struct({
      address: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
      caption: Schema.optionalKey(Line),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
}

/** Everything Vivid can show. A new kind is added here and fails to compile on every surface. */
export const Shown = Schema.TaggedUnion({
  Table,
  Chart,
  Steps,
  Options,
  Comparison,
  Links,
  Facts,
  Draft,
  Schedule,
  Form,
  Pictures,
})
export type Shown = typeof Shown.Type

/**
 * The `show` tool's input as a surface reads it back from the conversation. `kind` is the word
 * the model writes ("table"); `Shown` is what the surfaces draw.
 */
export const ShowRequest = Schema.Struct({ show: Shown })
export interface ShowRequest extends Schema.Schema.Type<typeof ShowRequest> {}
