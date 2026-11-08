import { ArtifactContent, type ArtifactReference } from '@vivid/contracts'
import { artifacts, LiveState, opening } from '@vivid/state'
import { Option, Predicate } from 'effect'
import { Share } from 'lucide-react-native'
import { useState } from 'react'
import { View } from 'react-native'
import { openFile, useOpening, type Asked } from '../../data/artifact'
import { useLive, useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { IconButton, Label, Notice, Press, radius, EDGE } from '../../ui/ui'
import { FirstPage, Glyph, storedFile } from './Look'
import { ArtifactViewer } from './Viewer'

/**
 * A file or document Vivid delivered, where it delivered it in a Thread: its first page, its name,
 * what it is and which version. Pressing it opens it whole with its history (`ArtifactViewer`);
 * a file's Share is on the card itself, since having the file is usually the point of being sent
 * one, and the share sheet is how a phone opens it in another app or keeps it.
 *
 * The card shows the version that reply delivered, as the web's does (`apps/web/src/screen/
 * artifact/Card.tsx`): the conversation is a record. It says so when there is a newer one.
 */
export function ArtifactCard({ delivered }: { delivered: typeof ArtifactReference.Type }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const sharing = useOpening()
  const asked: Asked = { id: delivered.id, version: delivered.version }
  const state = useLive(data.artifacts.one.get(asked))
  const [opened, setOpened] = useState(false)
  return (
    <>
      {LiveState.$match(state, {
        Loading: () => (
          <View
            style={{
              width: 280,
              aspectRatio: 0.92,
              borderRadius: radius.card,
              backgroundColor: c.subtle,
            }}
          />
        ),
        Failed: ({ failure }) => (
          <Label size="label" tone="ink-3">
            {Predicate.isTagged(failure, 'NotFound')
              ? 'This was removed from the thread.'
              : 'This could not be shown right now.'}
          </Label>
        ),
        Ready: ({ value }) => {
          const holds = artifacts.holdsOf(value.content)
          const key = `${value.artifact.id}@${value.shown.number}`
          const unopened = opening.failureOf(sharing, key)
          const file = ArtifactContent.guards.File(value.content)
            ? Option.some(value.content.output)
            : Option.none()
          return (
            <View style={{ width: 280, gap: 6 }}>
              <Press
                accessibilityRole="button"
                accessibilityLabel={`Open ${value.artifact.title}`}
                accessibilityHint="Shows it whole, with its versions"
                onPress={() => setOpened(true)}
                style={{
                  padding: 8,
                  gap: 10,
                  borderRadius: radius.card,
                  borderCurve: 'continuous',
                  backgroundColor: c['grouped-card'],
                  borderWidth: EDGE,
                  borderColor: c.border,
                }}
              >
                <FirstPage detail={value} style={{ width: '100%', aspectRatio: 4 / 3 }} />
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4 }}
                >
                  <Glyph holds={holds} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Label size="footnote" numberOfLines={1}>
                      {value.artifact.title}
                    </Label>
                    <Label size="caption" tone="ink-3" numberOfLines={1}>
                      {artifacts.holdsLine(holds, value.shown.number)}
                    </Label>
                  </View>
                  {Option.isSome(file) && (
                    <IconButton
                      icon={Share}
                      label={`Share or open ${value.artifact.title} in another app`}
                      disabled={opening.isWaiting(sharing)}
                      onPress={() => openFile(data, storedFile(value, file.value))}
                    />
                  )}
                </View>
                {value.artifact.version > value.shown.number && (
                  <Label size="caption" tone="ink-3" style={{ paddingLeft: 4 }}>
                    Version {value.artifact.version} is the newest.
                  </Label>
                )}
              </Press>
              {Option.isSome(unopened) && <Notice message={unopened.value} />}
            </View>
          )
        },
      })}
      {opened && <ArtifactViewer asked={asked} onClose={() => setOpened(false)} />}
    </>
  )
}
