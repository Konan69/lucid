import { ArtifactContent, type ArtifactReference } from '@vivid/contracts'
import { artifacts, LiveState } from '@vivid/state'
import { Option, Predicate } from 'effect'
import { useState } from 'react'
import { artifactLive, type Asked } from '../../data/artifact'
import { useLive } from '../../data/live'
import { engine } from '../../data/runtime'
import { cn } from '../../ui/cn'
import { Skeleton } from '../../ui/skeleton'
import { PRESS } from '../motion'
import { Refused } from '../thread/Rows'
import { FirstPage, kindOfHolds, Mark } from './Look'
import { ArtifactViewer, FileActions } from './Viewer'

/**
 * A file or document Vivid delivered, where it delivered it in the Thread: its first page, its
 * name, what it is and which version, and the ways to have it. Pressing the page opens it whole
 * with its history (`ArtifactViewer`); a file's Download and Open are on the card itself, since
 * having the file is usually the point of being sent one.
 *
 * The card shows the version that reply delivered: the conversation is a record, and "here is
 * version 2" stays version 2 when a version 3 comes later. It says so when there is a newer one.
 *
 * It is a card and not a bubble: a delivered thing is a thing to use, as a display is
 * (`Message.tsx` `Written`), and it stands in the reply's column at the width of the composer's
 * bubbles so a page has room to be recognised.
 */
export function ArtifactCard({ delivered }: { delivered: typeof ArtifactReference.Type }) {
  const asked: Asked = { id: delivered.id, version: delivered.version }
  const query = artifactLive.get(asked)
  const state = useLive(query)
  const [opened, setOpened] = useState<Option.Option<Asked>>(Option.none())
  return (
    <>
      {LiveState.$match(state, {
        Loading: () => <Skeleton className="h-64 w-full max-w-80" />,
        Failed: ({ failure }) =>
          Predicate.isTagged(failure, 'NotFound') ? (
            <p className="text-label text-ink-3">This was removed from the Thread.</p>
          ) : (
            <Refused onRetry={() => engine.registry.refresh(query.atom)}>
              This could not be shown right now.
            </Refused>
          ),
        Ready: ({ value }) => {
          const holds = artifacts.holdsOf(value.content)
          const newer = value.artifact.version > value.shown.number
          return (
            <article className="w-full max-w-80 overflow-hidden rounded-card bg-surface-3 p-2 edge">
              <button
                type="button"
                onClick={() => setOpened(Option.some(asked))}
                aria-label={`Open ${value.artifact.title}`}
                className={cn(
                  'block w-full cursor-pointer rounded-control outline-none focus-visible:edge-primary',
                  PRESS,
                )}
              >
                <FirstPage detail={value} className="aspect-4/3" />
              </button>
              <div className="flex items-center gap-2.5 px-1 pt-2.5 pb-1">
                <Mark kind={kindOfHolds(holds)} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-title text-ink">{value.artifact.title}</span>
                  <span className="block truncate text-meta font-meta text-ink-3 tabular-nums">
                    {artifacts.holdsLine(holds, value.shown.number)}
                  </span>
                </span>
              </div>
              {newer && (
                <p className="px-1 pb-1 text-meta font-meta text-ink-3">
                  Version {value.artifact.version} is the newest.
                </p>
              )}
              {ArtifactContent.guards.File(value.content) && (
                <div className="flex justify-end gap-2 px-1 pt-1.5 pb-1 *:h-7 *:px-2.5">
                  <FileActions
                    id={value.artifact.id}
                    version={value.shown.number}
                    output={value.content.output}
                    quiet
                  />
                </div>
              )}
            </article>
          )
        },
      })}
      <ArtifactViewer opened={opened} onClose={() => setOpened(Option.none())} />
    </>
  )
}
