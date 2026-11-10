import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  GenerationTask,
  hook,
  type ConversationId,
  type EntryRecord,
  type Harness,
  type TaskId,
} from '@earendil-works/pi-durable'
import { createParser } from '@openuidev/lang-core'
import { stretches } from '@vivid/contracts/display'
import { Effect, Option, Schema } from 'effect'
import spec from './agents/parts.json' with { type: 'json' }
import { runInputs } from './deliveries.ts'
import { pi } from './threads.ts'

/**
 * The parser a surface draws with, over the same library: what it reports here is what a screen
 * would fail to draw. Vivid could not see that before; on 27 October 2026 it redrew one display
 * four times in a reply, calling each "glitched", because a `Card` variant was not one of the two
 * the library has.
 */
const parser = createParser(spec.schema, spec.root)

/**
 * What OpenUI's parser reports about each whole display of an answer, one line per error, named
 * by the display's place in the answer and the statement it is in. Displays are found with the
 * stretch finder the surfaces draw with; one still arriving is not judged.
 */
const faultsOf = (answer: AssistantMessage) => {
  const text = answer.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
  const displays = text.flatMap((said) =>
    stretches(said).flatMap((stretch) =>
      stretch.kind === 'display' && stretch.whole ? [stretch.text] : [],
    ),
  )
  return displays.flatMap((display, index) =>
    parser
      .parse(display)
      .meta.errors.map((error) =>
        error.statementId === undefined
          ? `display ${index + 1}: ${error.message}`
          : `display ${index + 1}, \`${error.statementId}\`: ${error.message}`,
      ),
  )
}

/** What the model is told when a display of its answer does not draw. */
const correctionOf = (faults: ReadonlyArray<string>) =>
  [
    'A display in your last reply does not draw. OpenUI reported:',
    ...faults.map((fault) => `- ${fault}`),
    'Send that display again, fixed, as a whole openui-lang display, with no words about the fix.',
  ].join('\n')

/**
 * The transcript kind of a run's record that it asked the model to fix a display: the generation
 * task that asked, and the words it asked with. Pi appends an `onYield` continuation as a plain
 * `pi.user` entry with no data, placed by no submission (Pi `src/harness/generation.ts`
 * `answer`), so nothing in that entry says it is not a Person's words. This record says it: the
 * continuation is the `pi.user` entry written by the task named here with exactly these words.
 * Its request id names the run's first input, so a run writes one, and a later generation of the
 * same run finds the record of an earlier task and does not ask again.
 */
const CORRECTION_ENTRY = 'vivid.correction'
const CorrectionData = Schema.Struct({ task: Schema.Int, text: Schema.String })
interface CorrectionData extends Schema.Schema.Type<typeof CorrectionData> {}
const decodeCorrection = Schema.decodeUnknownOption(CorrectionData)

/**
 * Record the correction for this run and say whether this task may ask it: only the task the
 * run's one record names. A replay of the same task after a restart finds its own record and asks
 * again, as it would have.
 */
const correct = Effect.fn('Correction.correct')(function* (
  harness: Harness,
  conversationId: ConversationId,
  task: TaskId,
  text: string,
) {
  const [first] = yield* runInputs(harness, conversationId)
  const conversation = yield* pi(() => harness.conversation(conversationId, BACKGROUND_CONTEXT))
  if (first === undefined || conversation === undefined) return Option.none<string>()
  const submission = yield* pi(() =>
    conversation.submit(
      {
        type: 'write',
        entry: { kind: CORRECTION_ENTRY, data: { task, text } },
        requestId: `${CORRECTION_ENTRY}:${first}`,
      },
      BACKGROUND_CONTEXT,
    ),
  )
  const { entry } = yield* pi(() => submission.status(BACKGROUND_CONTEXT))
  if (entry === undefined) return Option.none<string>()
  const record = yield* pi(() => conversation.commit((tx) => tx.entry(entry), BACKGROUND_CONTEXT))
  return Option.filter(
    Option.flatMap(Option.fromUndefinedOr(record), (written) => decodeCorrection(written.data)),
    (kept) => kept.task === task,
  ).pipe(Option.map((kept) => kept.text))
})

/**
 * Check every display of a final answer before the run settles, the way T3 checks a page before
 * it shows it: when OpenUI's parser reports errors, the run goes on once with words naming them,
 * so the model sends that display again. The answer itself streamed and is kept as it was. Pi
 * takes the first continuation of all `onYield` hooks and drops it when the boundary places a
 * Person's new message, which then starts the next run instead.
 */
export const correctionHooks = (
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  harness: Effect.Effect<Harness>,
) =>
  hook(GenerationTask, {
    onYield: (answer, api) => {
      const faults = faultsOf(answer)
      if (faults.length === 0) return undefined
      return run(
        Effect.flatMap(harness, (opened) =>
          correct(opened, api.conversationId, api.taskId, correctionOf(faults)),
        ),
      ).then(Option.match({ onNone: () => undefined, onSome: (text) => ({ continue: text }) }))
    },
  })

/**
 * The transcript as Vivid's reply reads once a correction is made: without the continuation Pi
 * appended, which is Vivid talking to itself and, read as a delivery, would be drawn as the
 * Person's words, end the measure of its response and begin a run of its own; and without the
 * answer it superseded, whose words and broken display the corrected answer replaces. That answer
 * is the model message the continuing task wrote (with any failed attempt of the same task); it is
 * left out only when the continuation is there, because Pi drops a continuation when the boundary
 * places a Person's new message, and then that answer is the run's last. It was still paid for,
 * so it is returned as `superseded` for the response's usage. The record is written before the
 * answer it corrects, so a read from the run's start meets it first.
 */
export const corrected = (entries: ReadonlyArray<EntryRecord>) => {
  const asked = new Map<number, string>()
  const continued = new Set<number>()
  const continuations = new Set<number>()
  for (const entry of entries) {
    const kept = entry.kind === CORRECTION_ENTRY ? decodeCorrection(entry.data) : Option.none()
    if (Option.isSome(kept)) asked.set(kept.value.task, kept.value.text)
    if (entry.kind !== 'pi.user' || entry.byTaskId === undefined) continue
    const text = asked.get(entry.byTaskId)
    const [message] = entry.model === undefined ? [] : entry.model
    if (text === undefined || message === undefined || message.content !== text) continue
    continued.add(entry.byTaskId)
    continuations.add(entry.id)
  }
  const superseded = (entry: EntryRecord) =>
    entry.kind === 'pi.assistant' && entry.byTaskId !== undefined && continued.has(entry.byTaskId)
  return {
    kept: entries.filter((entry) => !continuations.has(entry.id) && !superseded(entry)),
    superseded: entries.filter(superseded),
  }
}

/** The transcript as screens and learning read it: `corrected` without what was superseded. */
export const withoutCorrections = (entries: ReadonlyArray<EntryRecord>) => corrected(entries).kept
