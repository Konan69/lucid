import { MemoryScope, type Memory as MemoryRecord } from '@vivid/contracts'
import { useState } from 'react'
import { change, live, LiveState, useLive } from '../../data/live'
import { Button } from '../../ui/Button'
import { Awaiting, Empty, Section } from './Parts'

const WHERE = (memory: MemoryRecord) =>
  MemoryScope.match(memory.scope, {
    Person: () => 'About you',
    Company: () => 'The whole company knows',
    Thread: ({ title }) => `From “${title}”`,
  })

/**
 * What Vivid knows. Everything it has kept is listed in plain sentences, with where it learned
 * each one, and the Person can correct or remove any of them: memory they cannot see and change
 * would not be theirs. The page at the top is what Vivid reads before each response.
 */
export function Memory() {
  const memory = useLive(live.memory)
  if (LiveState.$is('Failed')(memory)) {
    return (
      <Section title="What Vivid knows">
        <Empty>
          Memory is not available on this installation right now. Vivid still works; it just does
          not carry things between threads.
        </Empty>
      </Section>
    )
  }
  if (!LiveState.$is('Ready')(memory)) return <Awaiting state={memory} />
  const { brief, memories } = memory.value
  return (
    <>
      <Section title="In short" detail="What Vivid reads before it answers you.">
        <p className="px-4 py-3 text-label whitespace-pre-wrap text-ink-2">
          {brief.text.trim().length === 0
            ? 'Nothing yet. As you work together, Vivid keeps what will matter later.'
            : brief.text}
        </p>
      </Section>
      <Section
        title="Everything it has kept"
        detail="Correct what is wrong. Remove what it should not keep."
      >
        {memories.length === 0 && <Empty>Nothing kept yet.</Empty>}
        {memories.map((item) => (
          <MemoryRow key={item.id} memory={item} />
        ))}
      </Section>
    </>
  )
}

function MemoryRow({ memory }: { memory: MemoryRecord }) {
  const [draft, setDraft] = useState<string | null>(null)
  const forget = () => void change((client) => client.ForgetMemory({ id: memory.id }))
  const correct = (content: string) =>
    void change((client) => client.CorrectMemory({ id: memory.id, content }))

  if (draft !== null) {
    return (
      <form
        className="flex items-center gap-2 px-4 py-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.trim().length > 0 && draft.trim() !== memory.content) correct(draft.trim())
          setDraft(null)
        }}
      >
        <input
          // Editing was just asked for; the cursor belongs in the sentence being corrected.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={draft}
          maxLength={1000}
          onChange={(event) => setDraft(event.currentTarget.value)}
          className="h-8 min-w-0 flex-1 rounded-control bg-well px-3 text-label text-ink ring-line outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="sm" variant="primary">
          Save
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
