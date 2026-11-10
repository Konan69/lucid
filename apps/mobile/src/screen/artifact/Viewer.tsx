import { ArtifactContent, type ArtifactDetail } from '@vivid/contracts'
import { artifacts, LiveState, makeWhen, opening, removing, revising, thisReader } from '@vivid/state'
import { Option, Predicate } from 'effect'
import { Check, PencilLine, Share } from 'lucide-react-native'
import { useState } from 'react'
import { Image, useWindowDimensions, View } from 'react-native'
import {
  closeEditor,
  editDocument,
  openFile,
  removeArtifact,
  saveDocument,
  useOpening,
  useRemoving,
  useRevising,
  type Asked,
} from '../../data/artifact'
import { openWebLink } from '../../data/links'
import { useLive, useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { Row, Section } from '../../ui/List'
import { Prose } from '../../ui/Prose'
import { Sheet } from '../../ui/Sheet'
import { Button, confirmDestructive, Field, Label, Notice, radius, Skeleton } from '../../ui/ui'
import { storedFile, usePictureSource, writtenFile } from './Look'

const when = makeWhen(thisReader())

/**
 * One Artifact opened on the phone, as the system's page sheet: the version being read, whole,
 * every version under it, and what can be done with it. A file is handed to the share sheet
 * ("Open in", Save to Files, AirDrop); a document is read as formatted text, shared as Markdown,
 * and revised by hand through the session's editor (`@vivid/state` `revising`). The same as the
 * web's dialog (`apps/web/src/screen/artifact/Viewer.tsx`), laid out for one column.
 *
 * Which version is read is the sheet's own choice and starts at the one it was opened on. Edit is
 * offered on the newest only: the server refuses a revision made from anything older.
 *
 * Delete, under the versions, asks first and removes the Artifact with every version, as the
 * Library's "Delete file" does (`screen/Library.tsx`). Once it is gone the live query says so here.
 */
export function ArtifactViewer({ asked, onClose }: { asked: Asked; onClose: () => void }) {
  const data = useLiveData()
  const [version, setVersion] = useState<Option.Option<number>>(
    'version' in asked ? Option.some(asked.version) : Option.none(),
  )
  const reading: Asked = Option.match(version, {
    onNone: () => ({ id: asked.id }),
    onSome: (number) => ({ id: asked.id, version: number }),
  })
  const state = useLive(data.artifacts.one.get(reading))
  // Closing the sheet closes an editor in it; what was typed is dropped.
  const close = () => {
    closeEditor(data)
    onClose()
  }
  return LiveState.$match(state, {
    Loading: () => (
      <Sheet onClose={close}>
        <Skeleton rows={4} />
      </Sheet>
    ),
    Failed: ({ failure }) => (
      <Sheet title="Not available" onClose={close}>
        <Notice
          message={
            Predicate.isTagged(failure, 'NotFound')
              ? 'This was removed from its thread.'
              : 'This could not be opened right now. Try again in a moment.'
          }
        />
      </Sheet>
    ),
    Ready: ({ value }) => (
      <Shown
        detail={value}
        onClose={close}
        onPick={(number) =>
          setVersion(number === value.artifact.version ? Option.none() : Option.some(number))
        }
      />
    ),
  })
}

/** A version, read, with its versions and actions. */
function Shown({
  detail,
  onClose,
  onPick,
}: {
  detail: ArtifactDetail
  onClose: () => void
  onPick: (number: number) => void
}) {
  const data = useLiveData()
  const editor = useRevising()
  const sharing = useOpening()
  const deleting = useRemoving()
  const { artifact, shown, content } = detail
  const editing = revising.isEditing(editor, artifact.id)
  const newest = shown.number === artifact.version
  const key = `${artifact.id}@${shown.number}`
  const unopened = opening.failureOf(sharing, key)
  const busy = opening.isWaiting(sharing)
  const unremoved = removing.refusalOf(deleting, artifact.id)
  const line = `${artifacts.holdsLine(artifacts.holdsOf(content), shown.number)} · ${artifacts.madeByWords(shown.madeBy)}`
  if (editing && ArtifactContent.guards.Document(content)) {
    return (
      <Editor
        key={key}
        title={artifact.title}
        body={content.body}
        onClose={() => closeEditor(data)}
      />
    )
  }
  return (
    <Sheet
      title={artifact.title}
      detail={line}
      onClose={onClose}
      footer={
        <View style={{ gap: 8 }}>
          {Option.isSome(unopened) && <Notice message={unopened.value} />}
          {ArtifactContent.match(content, {
            Document: ({ body }) => (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    icon={Share}
                    label={busy ? 'One moment…' : 'Share'}
                    disabled={busy}
                    onPress={() => openFile(data, writtenFile(detail, body))}
                  />
                </View>
                {newest && (
                  <View style={{ flex: 1 }}>
                    <Button
                      kind="primary"
                      icon={PencilLine}
                      label="Edit"
                      onPress={() => editDocument(data, artifact.id, shown.number)}
                    />
                  </View>
                )}
              </View>
            ),
            File: ({ output }) => (
              <Button
                kind="primary"
                icon={Share}
                label={busy ? 'One moment…' : 'Share or open in…'}
                disabled={busy}
                onPress={() => openFile(data, storedFile(detail, output))}
              />
            ),
          })}
        </View>
      }
    >
      {!newest && (
        <View style={{ gap: 6, alignItems: 'flex-start' }}>
          <Label size="label" tone="ink-2">
            You are reading version {shown.number}. The newest is version {artifact.version}.
          </Label>
          <Button kind="ghost" label="Read the newest" onPress={() => onPick(artifact.version)} />
        </View>
      )}
      {ArtifactContent.match(content, {
        Document: ({ body }) => (
          <Prose
            text={body}
            plain={body}
            fresh={false}
            marks={[]}
            onLink={(address) => void openWebLink(address)}
          />
        ),
        File: ({ output }) => <FilePicture detail={detail} kind={artifacts.fileKind(output)} />,
      })}
      <Versions detail={detail} onPick={onPick} />
      {Option.isSome(unremoved) && <Notice message={unremoved.value} />}
      <Section>
        {/* While a deletion is on its way the row is text, not a control; the machine refuses too. */}
        {removing.isWaiting(deleting) ? (
          <Row title="Deleting…" danger />
        ) : (
          <Row
            title="Delete"
            danger
            onPress={() =>
              confirmDestructive({
                title: `Delete “${artifact.title}”?`,
                detail: 'Every version of it will be deleted. This cannot be undone.',
                action: 'Delete',
                onConfirm: () => removeArtifact(data, artifact.id),
              })
            }
          />
        )}
      </Section>
    </Sheet>
  )
}

/**
 * A file's picture, whole and fitted to the width: a PNG itself, or a PDF or Word file's rendered
 * first page. A file with no picture says how to read it instead.
 */
function FilePicture({ detail, kind }: { detail: ArtifactDetail; kind: string }) {
  const { colors: c } = useTheme()
  const { height } = useWindowDimensions()
  const source = usePictureSource(detail)
  if (Option.isNone(source)) {
    return (
      <Label size="label" tone="ink-2">
        {kind} files have no preview here. Share it to open it in another app.
      </Label>
    )
  }
  return (
    <Image
      source={source.value}
      resizeMode="contain"
      accessibilityLabel={`First page of ${detail.artifact.title}`}
      style={{
        width: '100%',
        height: height * 0.55,
        borderRadius: radius.control,
        backgroundColor: c.subtle,
      }}
    />
  )
}

/** Every version, newest first; the one being read is checked, and any other can be picked. */
function Versions({
  detail,
  onPick,
}: {
  detail: ArtifactDetail
  onPick: (number: number) => void
}) {
  const { colors: c } = useTheme()
  // "Now" for the times below is when the sheet was drawn; it is not open long enough to drift.
  const [opened] = useState(() => Date.now())
  return (
    <Section
      title={detail.versions.length === 1 ? '1 version' : `${detail.versions.length} versions`}
    >
      {detail.versions.map((version) => (
        <Row
          key={version.number}
          title={`Version ${version.number}`}
          detail={[
            `${when(version.at, opened)} · ${artifacts.madeByWords(version.madeBy)}`,
            ...(version.note === undefined ? [] : [version.note]),
          ].join('\n')}
          wrap
          trailing={
            version.number === detail.shown.number ? (
              <Check size={18} strokeWidth={2} color={c.primary} />
            ) : undefined
          }
          onPress={() => onPick(version.number)}
        />
      ))}
    </Section>
  )
}

/**
 * The document's Markdown in a field, filling the sheet. It starts from what the Person had typed
 * when a save was refused (the machine keeps it), or else from the newest text. Save is held
 * while the text is empty, unchanged or already being saved; the machine refuses a second press.
 */
function Editor({ title, body, onClose }: { title: string; body: string; onClose: () => void }) {
  const data = useLiveData()
  const editor = useRevising()
  const [typed, setTyped] = useState(() => Option.getOrElse(revising.keptText(editor), () => body))
  const valid = revising.typedBody(typed)
  const waiting = revising.isWaiting(editor)
  const notice = revising.noticeOf(editor)
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button kind="ghost" label="Cancel" onPress={onClose} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              kind="primary"
              label={waiting ? 'Saving…' : 'Save'}
              disabled={
                waiting || Option.isNone(valid) || (typed === body && Option.isNone(notice))
              }
              onPress={() => {
                if (Option.isSome(valid)) saveDocument(data, valid.value)
              }}
            />
          </View>
        </View>
      }
    >
      {Option.isSome(notice) && <Notice message={notice.value} />}
      <Field
        accessibilityLabel="Document text"
        multiline
        autoFocus
        value={typed}
        onChangeText={setTyped}
        editable={!waiting}
        textAlignVertical="top"
        style={{ minHeight: 320 }}
      />
    </Sheet>
  )
}
