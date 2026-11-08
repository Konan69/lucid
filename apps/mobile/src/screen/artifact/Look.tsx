import {
  ArtifactContent,
  ArtifactHolds,
  type ArtifactDetail,
  type ArtifactFile,
} from '@vivid/contracts'
import { artifacts, opening } from '@vivid/state'
import { Option } from 'effect'
import { File, FileImage, FileText, Hash } from 'lucide-react-native'
import { Image, View, type ImageStyle, type StyleProp } from 'react-native'
import { bearer } from '../../data/transport'
import { useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { Label, radius } from '../../ui/ui'

/**
 * How an Artifact looks on the phone before it is opened: the glyph for its kind, as the phone's
 * Library draws a file (`screen/Library.tsx`, a 20-point outline glyph in the secondary ink), and
 * its first page. The same kinds as the web's marks (`apps/web/src/screen/artifact/Look.tsx`).
 */

/**
 * A kind's glyph at the Library's size and weight: Vivid's Markdown as `#`, a picture, a page of
 * text for a PDF or Word file, and a plain file for anything else.
 */
export function Glyph({ holds, size = 20 }: { holds: ArtifactHolds; size?: number }) {
  const { colors: c } = useTheme()
  const look = { size, strokeWidth: 1.6, color: c['foreground-secondary'] }
  return ArtifactHolds.match(holds, {
    Document: () => <Hash {...look} />,
    File: ({ output }) => {
      if (output.mimeType.startsWith('image/')) return <FileImage {...look} />
      if (output.mimeType === 'application/pdf' || output.mimeType.includes('wordprocessingml'))
        return <FileText {...look} />
      return <File {...look} />
    },
  })
}

/**
 * Where a version's picture is read: the Person's own server, with the token the phone is signed
 * in with (a phone has no cookie), as the chat asks for a stored picture (`screen/chat/Said.tsx`).
 */
export function usePictureSource(detail: ArtifactDetail) {
  const data = useLiveData()
  return Option.map(artifacts.pictureRole(detail.content), (role) => ({
    uri: `${data.session.server}${artifacts.artifactAddress(detail.artifact.id, detail.shown.number, role)}`,
    headers: bearer(data.session.token),
  }))
}

/**
 * The first page of a version in a frame of the given style: its picture (a PNG, or a PDF or Word
 * file's rendered first page), a document's opening lines on a sheet, or the kind's glyph.
 */
export function FirstPage({
  detail,
  style,
}: {
  detail: ArtifactDetail
  style: StyleProp<ImageStyle>
}) {
  const { colors: c } = useTheme()
  const source = usePictureSource(detail)
  if (Option.isSome(source)) {
    return (
      <Image
        source={source.value}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
        style={[{ backgroundColor: c.subtle, borderRadius: radius.control }, style]}
      />
    )
  }
  return (
    <View
      style={[
        {
          backgroundColor: c.subtle,
          borderRadius: radius.control,
          borderCurve: 'continuous',
          overflow: 'hidden',
          paddingTop: 12,
          paddingHorizontal: 18,
        },
        style,
      ]}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: c['grouped-card'],
          borderTopLeftRadius: 4,
          borderTopRightRadius: 4,
          paddingHorizontal: 12,
          paddingTop: 12,
          gap: 4,
          alignItems: ArtifactContent.guards.File(detail.content) ? 'center' : 'stretch',
          justifyContent: ArtifactContent.guards.File(detail.content) ? 'center' : 'flex-start',
        }}
      >
        {ArtifactContent.match(detail.content, {
          Document: ({ body }) => (
            <Label size="caption" tone="ink-3" numberOfLines={8}>
              {artifacts.openingLines(body)}
            </Label>
          ),
          File: () => <Glyph holds={artifacts.holdsOf(detail.content)} size={32} />,
        })}
      </View>
    </View>
  )
}

/** What the share sheet is handed for a file Vivid made: its output, under its own name. */
export const storedFile = (detail: ArtifactDetail, output: ArtifactFile) => ({
  key: `${detail.artifact.id}@${detail.shown.number}`,
  name: output.name,
  source: opening.Source.cases.Stored.make({
    path: artifacts.artifactAddress(detail.artifact.id, detail.shown.number, 'output'),
  }),
})

/** What the share sheet is handed for a document: its text, as a Markdown file named by its title. */
export const writtenFile = (detail: ArtifactDetail, body: string) => ({
  key: `${detail.artifact.id}@${detail.shown.number}`,
  name: artifacts.documentFileName(detail.artifact.title),
  source: opening.Source.cases.Written.make({ text: body }),
})
