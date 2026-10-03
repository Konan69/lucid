import type { MeResponse } from '@vivid/contracts'
import { Workspace } from '@vivid/contracts'
import { draftPlace, greetingAt, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { startThread } from '../data/threads'
import { useAppearance } from '../data/vivid'
import { Face } from '../ui/Face'
import { Composer } from './thread/Composer'

/**
 * Home: Vivid, a greeting, and somewhere to write. There is nothing to set up and nothing to
 * choose; whatever the Person types becomes a Thread. There are no suggestion cards under the
 * composer: four generic ones used to sit there and were filler, the same ones already removed
 * on the phone.
 *
 * The composer is in the middle of the page, under the greeting, not at its foot: on this screen
 * writing is the only thing there is to do, so it sits where the eye already is. Once there is a
 * Thread the composer is at the bottom, under the conversation, where it belongs.
 */
export function First({ me }: { me: MeResponse }) {
  const { name } = useAppearance()
  // Read once: a greeting that changed while someone was looking at it would be a glitch.
  const [hello] = useState(() => greetingAt(new Date().getHours()))
  const first = me.person.name.trim().split(/\s+/u)[0]
  const where = Workspace.match(me.workspace, {
    Personal: () => 'What should I take off your plate?',
    Company: ({ company }) => `What should I take off your plate at ${company.name}?`,
  })
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-surface-0">
      <div className="mx-auto flex w-full max-w-(--thread-max-w) flex-1 flex-col justify-center px-2 py-10 sm:px-0">
        <div className="animate-rise-in px-4 sm:px-6">
          <span className="relative inline-flex">
            <span aria-hidden className="pointer-events-none absolute -inset-10 aura" />
            <Face size={64} mood="happy" className="relative" />
          </span>
          <h1 className="mt-6 font-display text-display font-strong tracking-display text-balance text-ink">
            {first === undefined || first.length === 0 ? `${hello}.` : `${hello}, ${first}.`}
          </h1>
          <p className="mt-2 text-section text-ink-3">{where}</p>
        </div>

        <div className="mt-6">
          <Composer
            place={draftPlace(me.person.id, {
              workspace: workspaceKey(me.workspace),
              thread: Option.none(),
            })}
            placeholder={`Message ${name}`}
            working={false}
            onSend={(text) => startThread(text)}
            onStop={() => undefined}
          />
        </div>
      </div>
    </section>
  )
}
