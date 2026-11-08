import type { ShelvedArtifact } from '@vivid/contracts'
import { artifacts, LiveState } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { shelfLive, type Asked } from '../../data/artifact'
import { useLive } from '../../data/live'
import { engine } from '../../data/runtime'
import { cn } from '../../ui/cn'
import { ENTER, PRESS, stagger } from '../motion'
import { Refused, TextButton } from '../thread/Rows'
import { kindOfHolds, Mark } from './Look'
import { ArtifactViewer } from './Viewer'

/** How many the section shows before "Show all": two rows of the Library's widest grid. */
const FIRST = 8

/**
 * What Vivid made in the Person's Threads, at the top of the Library: every file and document it
 * delivered in a Thread they can read in this workspace, newest first (`WatchArtifactShelf`).
 * Muse and Dots keep what the assistant made beside what the Person added (Muse
 * `files-and-library.md`, Dots `library` skill, "Save a new deliverable to Library"); here they
 * stay apart, because a Library file is something Vivid reads and an Artifact is something it
 * wrote, and they open differently.
 *
 * It says nothing until there is something: an empty section above the Person's own files would
 * be one more thing to read on a screen that is about their files. Each tile opens the Artifact
 * at its newest version, with its history (`ArtifactViewer`).
 */
export function ArtifactShelf() {
  const state = useLive(shelfLive)
  const [all, setAll] = useState(false)
  const [opened, setOpened] = useState<Option.Option<Asked>>(Option.none())
  return (
    <>
      {LiveState.$match(state, {
        Loading: () => null,
        Failed: () => (
          <Refused onRetry={() => engine.registry.refresh(shelfLive.atom)}>
            What Vivid made can’t be listed right now.
          </Refused>
        ),
        Ready: ({ value }) =>
          value.artifacts.length === 0 ? null : (
            <section aria-labelledby="made-by-vivid" className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="made-by-vivid" className="text-label font-title text-ink-3">
                  Made by Vivid
                </h2>
                {value.artifacts.length > FIRST && (
                  <span className="text-label">
                    <TextButton onClick={() => setAll((shown) => !shown)}>
                      {all ? 'Show fewer' : `Show all ${value.artifacts.length}`}
                    </TextButton>
                  </span>
                )}
              </div>
              <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                {(all ? value.artifacts : value.artifacts.slice(0, FIRST)).map((entry, place) => (
                  <li key={entry.artifact.id}>
                    <Tile
                      entry={entry}
                      place={place}
                      onOpen={() => setOpened(Option.some({ id: entry.artifact.id }))}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ),
      })}
      <ArtifactViewer opened={opened} onClose={() => setOpened(Option.none())} />
    </>
  )
}

/** One Artifact: its mark, its name, what it is, and the Thread it was made in. */
function Tile({
  entry,
  place,
  onOpen,
}: {
  entry: ShelvedArtifact
  place: number
  onOpen: () => void
}) {
  const { artifact, holds, threadTitle } = entry
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-card bg-surface-3 px-3 py-2.5 text-left edge outline-none hover:bg-surface-2 focus-visible:edge-primary',
        PRESS,
        ENTER,
        stagger(place),
      )}
    >
      <Mark kind={kindOfHolds(holds)} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title text-ink">{artifact.title}</span>
        <span className="block truncate text-meta font-meta text-ink-3 tabular-nums">
          {artifacts.holdsLine(holds, artifact.version)}
        </span>
        <span className="block truncate text-meta font-meta text-ink-3">In {threadTitle}</span>
      </span>
    </button>
  )
}
