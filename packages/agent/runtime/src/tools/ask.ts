import { defineTool } from './tool.ts'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import {
  HANDOFF_FIELDS_MOST,
  HandoffFieldPurpose,
  HandoffFormKind,
  HandoffKind,
  PrepareHandoffRequest,
  Tool,
  INPUT_QUESTIONS_MOST,
} from '@vivid/contracts'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'
import { text } from './inputs.ts'
import * as Option from 'effect/Option'

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

/** One field Vivid read on the page: its label exactly as the page outline names it. */
const handoffField = v.object({
  label: text('The field’s label exactly as the page outline shows it, such as "Password".', 200),
  purpose: v.pipe(
    v.picklist(HandoffFieldPurpose.literals),
    v.description('What the field holds, so the person gets the right keyboard.'),
  ),
})

const isFormKind = (kind: HandoffKind): kind is HandoffFormKind =>
  HandoffFormKind.literals.some((form) => form === kind)

/**
 * The step as the server takes it: fields make a form, none a step on the live screen. A CAPTCHA
 * or taking control has nothing to type into, so it is refused with fields rather than guessed.
 */
const handoffRequest = (data: {
  readonly kind: HandoffKind
  readonly summary: string
  readonly fields: ReadonlyArray<{ readonly label: string; readonly purpose: HandoffFieldPurpose }>
}): Option.Option<PrepareHandoffRequest> => {
  const [first, ...rest] = data.fields
  if (first === undefined)
    return Option.some(
      PrepareHandoffRequest.cases.Screen.make({ kind: data.kind, summary: data.summary }),
    )
  if (!isFormKind(data.kind)) return Option.none()
  return Option.some(
    PrepareHandoffRequest.cases.Form.make({
      kind: data.kind,
      summary: data.summary,
      fields: [first, ...rest],
    }),
  )
}

/**
 * Asking does not stop Vivid. One durable Input request carries everything Vivid needs together;
 * the tool returns as soon as the server has recorded it, and the turn goes on with whatever does
 * not depend on the answer. The answer comes back later as a new delivery (`inputs/store.ts`
 * `answer`). It joins the running response at the next turn boundary, or starts a new Run
 * in the Thread when nothing is running.
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
      /** Pi owns decoding and cancellation; this boundary runs the attributed RPC Effect. */
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
    /**
     * Hands the Person the one step on the Computer only they can do: a sign-in, a code, a
     * payment, a CAPTCHA, taking control. Like a question it does not stop Vivid: the server
     * records it and answers at once, the Person fills it on a secure form and finishes on the
     * live screen, and their finishing arrives later as a new delivery naming each field's result
     * and never a value (`apps/server/src/inputs/handoff.ts`). Grok Bot's secure handoff is the
     * reference (`~/ref/system-prompts-mined/mined/grok-bot-skills.md`, M10).
     */
    defineTool({
      name: Tool.request_handoff,
      description:
        'Hand the person the one step on your computer that only they can do, instead of asking for it in chat: a sign-in, a one-time code, a card payment, a CAPTCHA, or taking control. Open the page on your computer and read it first. For a form, give each field’s label exactly as the page outline names it; the person types the values on a secure form and you never see them. With no fields the person does the step on the live screen. A CAPTCHA, a passkey or a bank check is always a screen step. Fields that cannot be found are refused by label: hand the step over on the screen instead. This returns at once; your computer is the person’s until they finish, so do nothing on it until then, and end your turn in one short line when nothing else is left. When they finish you are told, with one result per field and never the values; look at the page before going on, because a filled field is not a site’s answer.',
      input: v.object({
        kind: v.pipe(
          v.picklist(HandoffKind.literals),
          v.description('SignIn, Code, Payment, Captcha or TakeControl.'),
        ),
        summary: text(
          'One sentence the person will read: the step and why, such as "Sign in to Example so I can download your invoices".',
          400,
        ),
        fields: v.pipe(
          v.array(handoffField),
          v.maxLength(HANDOFF_FIELDS_MOST),
          v.description('The fields to fill, in page order; empty for a step on the screen.'),
        ),
      }),
      /** Pi owns decoding and cancellation; this boundary runs the attributed RPC Effect. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const request = handoffRequest(data)
            if (Option.isNone(request)) return { output: views.handoffWithoutFields(data.kind) }
            const { client } = yield* Scope
            return { output: views.handoff(yield* client.PrepareHandoff(request.value)) }
          }),
          { signal, tool: 'request_handoff' },
        )
      },
    }),
  ] as const
}
