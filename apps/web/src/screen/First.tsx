import type { MeResponse } from '@vivid/contracts'
import { Workspace } from '@vivid/contracts'
import { draftPlace, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { ArrowUpRight } from 'lucide-react'
import { useState } from 'react'
import { live, useLiveValue } from '../data/live'
import { startThread } from '../data/threads'
import { Face } from '../ui/Face'
import { Composer } from './thread/Composer'

/** The greeting for the hour it is where the Person is: said once, when the screen opens. */
const greeting = () => {
  const hour = new Date().getHours()
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Morning'
  if (hour < 18) return 'Afternoon'
  return 'Evening'
}

/**
 * The first screen: Vivid, and somewhere to write. There is nothing to set up and nothing to
 * choose. Whatever the Person types becomes a Thread; the suggestions are things they could say,
 * drawn from their own Tasks, Routines and Library, and a fresh account gets four that work with
 * nothing connected.
 *
 * The composer is in the middle of the page, under the greeting, not at its foot: on this screen
 * writing is the only thing there is to do, so it sits where the eye already is. Once there is a
 * Thread the composer is at the bottom, under the conversation, where it belongs.
 */
export function First({ me }: { me: MeResponse }) {
  const suggestions = useLiveValue(live.suggestions)
  // Read once: a greeting that changed while someone was looking at it would be a glitch.
  const [hello] = useState(greeting)
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
            working={false}
            onSend={(text) => startThread(text)}
            onStop={() => undefined}
          />
        </div>

        <ul className="grid gap-2 px-4 sm:grid-cols-2 sm:px-6">
          {Option.match(suggestions, {
            onNone: () => [],
            onSome: (value) => value.suggestions,
          }).map((suggestion, position) => (
            <li
              key={suggestion.text}
              // Each arrives a beat after the one before it, once, as the screen opens.
              className={STAGGER[position % STAGGER.length]}
            >
              <button
                onClick={() => startThread(suggestion.text)}
                className="group/try flex size-full cursor-pointer items-start gap-3 rounded-card bg-surface-2 px-4 py-3.5 text-left transition-press duration-(--dur-fast) hover:bg-wash-pressed active:scale-98"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-title font-title text-ink">{suggestion.text}</span>
                  <span className="mt-1 block text-label font-meta text-ink-3">
                    {suggestion.reason}
                  </span>
                </span>
                <ArrowUpRight
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-ink-4 transition-colors duration-(--dur-fast) group-hover/try:text-accent-ink"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/** The four suggestions rise in one after another; the delays are fixed, so they are classes. */
const STAGGER = [
  'animate-rise-in',
  'animate-rise-in stagger-1',
  'animate-rise-in stagger-2',
  'animate-rise-in stagger-3',
] as const
