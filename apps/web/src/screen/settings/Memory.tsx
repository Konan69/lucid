import { MemoryScope, type Memory as MemoryRecord } from '@vivid/contracts'
import { Effect, Result } from 'effect'
import { useState } from 'react'
import { act } from '../../data/app'
import { changing, live, LiveState, useLive } from '../../data/live'
import { orSay } from '../../data/said'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Awaiting, Empty, Section } from './Parts'

const WHERE = (memory: MemoryRecord) =>
  MemoryScope.match(memory.scope, {
    Person: () => 'About you',
    Company: () => 'The whole company knows',
    Thread: ({ title }) => `From “${title}”`,
  })

/**
 * The knowledge Vivid has saved for reference: each fact in a plain sentence, with where it
 * learned it, and the Person can correct or remove any of them. The page at the top is a summary
 * the server writes from those same facts.
 *
 * This is one of Vivid's two kinds of memory and the screen says so. `WatchMemory` returns the
 * knowledge base only (`apps/server/src/memory/handlers.ts`), which Vivid searches when it needs
 * a fact. What is in front of Vivid on every response is the list of its own notes
 * (`packages/agent/runtime/src/context.ts`), and this query does not return those. So nothing
 * here is called everything Vivid knows, the summary is not called what Vivid reads before it
 * answers, and forgetting a fact here is not said to remove it from the notes (docs/25-memory.md).
 */
export function Memory() {
  const memory = useLive(live.memory)
  if (LiveState.$is('Failed')(memory)) {
    return (
      <Section title="Saved knowledge">
        <Empty>Unable to load saved knowledge right now. Try again in a moment.</Empty>
      </Section>
    )
  }
  if (!LiveState.$is('Ready')(memory)) return <Awaiting state={memory} />
  const { brief, memories } = memory.value
  return (
    <>
      <Section title="In short" detail="A summary of the saved knowledge below.">
        <p className="px-4 py-3 text-label whitespace-pre-wrap text-ink-2">
          {brief.text.trim().length === 0
            ? 'Nothing yet. Facts Vivid saves for reference are summed up here.'
            : brief.text}
        </p>
      </Section>
      <Section
        title="Saved knowledge"
        detail="Facts Vivid can look up. Correct what is wrong, or remove what it should not keep. Vivid’s own notes are not shown here."
      >
        {memories.length === 0 && <Empty>Nothing saved yet.</Empty>}
        {memories.map((item) => (
          <MemoryRow key={item.id} memory={item} />
        ))}
      </Section>
    </>
  )
}

function MemoryRow({ memory }: { memory: MemoryRecord }) {
  const [draft, setDraft] = useState<string | null>(null)
  const forget = () =>
    void act(
      orSay(
        changing((client) => client.ForgetMemory({ id: memory.id })),
        'That could not be forgotten. Try again.',
      ),
    )
  const [refused, setRefused] = useState(false)

  /** Saves a correction. The words stay in the field until it is saved; a refusal keeps them. */
  function correct(content: string) {
    return Effect.gen(function* () {
      if (content.length === 0 || content === memory.content) {
        setDraft(null)
        return
      }
      const saved = yield* changing((client) => client.CorrectMemory({ id: memory.id, content }))
      setRefused(Result.isFailure(saved))
      if (Result.isSuccess(saved)) setDraft(null)
    })
  }

  if (draft !== null) {
    return (
      <form
        className="flex items-center gap-2 px-4 py-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          void act(correct(draft.trim()))
        }}
      >
        <Input
          compact
          // Editing was just asked for; the cursor belongs in the sentence being corrected.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={draft}
          maxLength={1000}
          aria-label="What Vivid should know instead"
          aria-invalid={refused}
          onChange={(event) => setDraft(event.currentTarget.value)}
          className="flex-1"
        />
        <Button type="submit" size="sm">
          {refused ? 'Try again' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </form>
    )
  }
  return (
    <div className="group/memory flex min-h-14 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-label text-ink">{memory.content}</div>
        <div className="text-label text-ink-3">
          {WHERE(memory)} · learned from {memory.learnedFrom.name}
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={() => setDraft(memory.content)}>
        Correct
      </Button>
      <Button size="sm" variant="ghost" onClick={forget}>
        Forget
      </Button>
    </div>
  )
}
