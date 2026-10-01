import { defineTool } from '@flue/runtime'
import { SkillId } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import * as v from 'valibot'
import { asActing, type Acting } from '../client.ts'
import { forCompany, id, text } from './inputs.ts'
import { settle } from './result.ts'

/** Saved procedures are read on demand and storing one never schedules work. */
export function skillTools(acting: Option.Option<Acting>) {
  return [
    defineTool({
      name: 'read_skill',
      description:
        'Read a saved procedure whose useWhen matches this request before following its steps.',
      input: v.object({ id }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client
                .ReadSkill({ id: SkillId.make(data.id) })
                .pipe(Effect.map((output) => ({ output }))),
            ),
          ),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'save_skill',
      description:
        'Save a reusable procedure when the person asks. Include its decisions and approval needs; saving it does not create a Routine.',
      input: v.object({
        name: text('A short procedure name.', 80),
        useWhen: text('When to use this procedure, in one sentence.', 300),
        instructions: text(
          'Steps, decisions, expected result and approval needs in Markdown.',
          20_000,
        ),
        forCompany,
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client.SaveSkill(data).pipe(Effect.map((output) => ({ output }))),
            ),
          ),
          { signal },
        )
      },
    }),
  ] as const
}
