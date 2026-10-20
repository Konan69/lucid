import { defineTool } from '@flue/runtime'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import { Tool, INPUT_QUESTIONS_MOST } from '@vivid/contracts'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'
import { text } from './inputs.ts'

/** Each question is self-contained; several picks are allowed only when the choices truly coexist. */
const question = v.object({
  question: text('One self-contained question the person can answer without another turn.', 400),
  options: v.pipe(
    v.array(
      v.object({
        label: text('A short choice.', 200),
        detail: text('The consequence of this choice.', 400),
      }),
    ),
    v.maxLength(6),
    v.description(
      'Zero to six choices; use an empty list and allowsOwnAnswer true for written words.',
    ),
  ),
  several: v.pipe(
    v.boolean(),
    v.description(
      'True only when more than one option can truly apply together; false for alternatives.',
    ),
  ),
  allowsOwnAnswer: v.pipe(
    v.boolean(),
    v.description('Whether the person may write their own answer instead of choosing options.'),
  ),
})

/**
 * Asking does not stop Vivid. One durable Input request carries everything Vivid needs together;
 * the tool returns as soon as the server has recorded it, and the turn goes on with whatever does
 * not depend on the answer. The answer comes back later as a new delivery (`inputs/store.ts`
 * `answer`): Flue joins it into the response still being written, at the next turn boundary
 * (2.2.2 `applyQueuedJoins`), or starts a new Run in the Thread when nothing is running.
 *
 * Ported from Codex's async question, which shipped with the GPT-6 family (GPT-6 Astra first):
 * `codex-rs/core/src/tools/handlers/request_user_input_async.rs` `RequestUserInputAsyncHandler`
 * records the questions as a turn item and returns `{"accepted":true}` without ending the turn,
 * and the reply arrives through `CodexThread::start_or_steer_turn`, steering a running turn or
 * starting one (openai/codex b5115cdd). The description follows Codex's
 * `REQUEST_USER_INPUT_ASYNC_DESCRIPTION` and GPT-6 Astra's "Working with the user" instructions
 * (`models-manager/models.json`). Codex leaves the answer's arrival to its clients; Vivid's server
 * owns it, so a question outlives the Run that asked it, as T3 Code keeps Codex's
 * (`docs/internals/providers.md`, "Protocol traps"). It is the shape of React Suspense: the work
 * that reads the answer waits for it while everything else goes on, and resumes when it arrives.
 */
export function askTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.ask_person,
      description:
        'Ask the person everything you need to decide safely in ONE call: one to four questions, answered together. Gather all missing details instead of asking one question per turn. Set several true only when more than one option can truly apply. This returns at once without ending your turn or waiting for a reply; the answer arrives later as a new message, while you are still working or as a new turn. Keep doing the work that does not depend on the answer. Do not do the work that does until it arrives: time passing is not an answer. When nothing is left that can go on without it, end your turn in one short line, without asking the question again. If the person writes to you instead of answering, the question is closed and their message is their reply.',
      // No `summary`, unlike the other tools: the question is already the sentence the Person
      // reads for this step, and asking for it twice cost a turn. With it required, five of six
      // first Threads on 5 October 2026 had this call refused for the missing field and made
      // again, so the first question arrived a model round late behind a failed step.
      input: v.object({
        questions: v.pipe(
          v.tupleWithRest([question], question),
          v.maxLength(INPUT_QUESTIONS_MOST),
          v.description(
            'One to four questions. Include everything needed to continue this work in this request.',
          ),
        ),
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const { request } = yield* client.AskInput({
              questions: Arr.map(data.questions, (item) => ({
                question: item.question,
                options: item.options,
                selection: item.several ? 'Several' : 'One',
                allowsOwnAnswer: item.allowsOwnAnswer,
              })),
            })
            return { output: views.inputRequest(request) }
          }),
          { signal, tool: 'ask_person' },
        )
      },
    }),
  ] as const
}
