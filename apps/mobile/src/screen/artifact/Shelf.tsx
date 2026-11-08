import { artifacts, LiveState } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import type { Asked } from '../../data/artifact'
import { useLive, useLiveData } from '../../data/live'
import { Row, Section } from '../../ui/List'
import { Glyph } from './Look'
import { ArtifactViewer } from './Viewer'

/** How many rows the section lists before "Show all". */
const FIRST = 5

/**
 * What Vivid made in the Person's threads, at the top of the Library: every file and document it
 * delivered in a thread they can read in this workspace, newest first. The web's section is the
 * same list (`apps/web/src/screen/artifact/Shelf.tsx`). It says nothing until there is something,
 * and a row opens the Artifact at its newest version, with its history.
 */
export function ArtifactShelf() {
  const data = useLiveData()
  const state = useLive(data.artifacts.shelf)
  const [all, setAll] = useState(false)
  const [opened, setOpened] = useState<Option.Option<Asked>>(Option.none())
  return (
    <>
      {LiveState.$match(state, {
        Loading: () => null,
        Failed: () => null,
        Ready: ({ value }) =>
          value.artifacts.length === 0 ? null : (
            <Section title="Made by Vivid">
              {(all ? value.artifacts : value.artifacts.slice(0, FIRST)).map((entry) => (
                <Row
                  key={entry.artifact.id}
                  leading={<Glyph holds={entry.holds} />}
                  title={entry.artifact.title}
                  detail={`${artifacts.holdsLine(entry.holds, entry.artifact.version)} · ${entry.threadTitle}`}
                  onPress={() => setOpened(Option.some({ id: entry.artifact.id }))}
                />
              ))}
              {value.artifacts.length > FIRST && (
                <Row
                  title={all ? 'Show fewer' : `Show all ${value.artifacts.length}`}
                  onPress={() => setAll((shown) => !shown)}
                />
              )}
            </Section>
          ),
      })}
      {Option.isSome(opened) && (
        <ArtifactViewer asked={opened.value} onClose={() => setOpened(Option.none())} />
      )}
    </>
  )
}
