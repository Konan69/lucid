import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { ada, admit, delivery, scenario, settled } from '../tests/requests.ts'
import { SkillFileMissing } from './skills.ts'

/** The refusal as the model reads it: the typed error beside the sentence. */
const decodeRefusal = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ ok: Schema.Literal(false), error: SkillFileMissing, message: Schema.String }),
  ),
)

/** The text of every tool result the model was given, newest last, as the model reads it. */
const results = (messages: Parameters<FauxResponseFactory>[0]['messages']) =>
  messages.flatMap((message) =>
    message.role === 'toolResult'
      ? [message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')]
      : [],
  )

const call = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })

describe('built-in skill reference files', () => {
  it.effect(
    'activation lists the files, read_skill_file returns one, an unknown file is refused',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          const skill = 'make-an-integration'
          let seen: ReadonlyArray<string> = []
          given.faux.setResponses([
            call('activate_skill', { name: skill }),
            call('read_skill_file', { skill, file: 'references/displays.md' }),
            call('read_skill_file', { skill, file: 'references/missing.md' }),
            (context) => {
              seen = results(context.messages)
              return fauxAssistantMessage('Done.')
            },
          ])
          const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
          expect(yield* settled(runtime, ada, 'thread-1', receipt.submissionId)).toMatchObject({
            reply: 'Done.',
            toolCalls: 3,
          })
          const [activated, read, refused] = seen
          expect(activated).toContain('<skill_instructions>')
          expect(activated).toContain('- references/displays.md: Data and controls for a display')
          expect(activated).toContain('- references/reminders.md: ')
          expect(activated).toContain('- references/schedules.md: ')
          expect(read).toMatch(/^## Data and controls for a display\n/u)
          const refusal = yield* decodeRefusal(refused)
          expect(refusal.error).toEqual(
            new SkillFileMissing({
              skill,
              file: 'references/missing.md',
              files: [
                'references/displays.md',
                'references/reminders.md',
                'references/schedules.md',
              ],
            }),
          )
          expect(refusal.message).toContain('references/displays.md')
        }),
      ),
  )
})
