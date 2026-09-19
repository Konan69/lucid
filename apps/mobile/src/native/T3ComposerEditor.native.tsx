import { requireNativeView } from 'expo'
import { Platform, View } from 'react-native'
import { composerColor } from './composerColor'
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import { StyleSheet } from 'react-native'

import { MOBILE_TYPOGRAPHY } from '../lib/typography'

import { useFontFamily } from '../lib/useFontFamily'
import { useThemeColor } from '../lib/useThemeColor'
import {
  acknowledgeComposerNativeEvent,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from './composerEditorRevision'
import type { ComposerEditorProps, ComposerEditorSelection } from './T3ComposerEditor.types'

const NATIVE_MODULE_NAME = 'T3ComposerEditor'
const EMPTY_SKILLS: NonNullable<ComposerEditorProps['skills']> = []

type NativeEditorEvent = NativeSyntheticEvent<{
  readonly value: string
  readonly selection: ComposerEditorSelection
  readonly eventCount: number
}>

type NativeSelectionEvent = NativeSyntheticEvent<{
  readonly value: string
  readonly selection: ComposerEditorSelection
  readonly eventCount: number
}>

type NativePasteImagesEvent = NativeSyntheticEvent<{
  readonly uris: ReadonlyArray<string>
}>

interface NativeComposerEditorRef {
  focus: () => Promise<void>
  blur: () => Promise<void>
  setSelection: (start: number, end: number) => Promise<void>
}

interface NativeComposerEditorProps extends ViewProps {
  readonly ref?: Ref<NativeComposerEditorRef>
  readonly controlledDocumentJson: string
  readonly themeJson: string
  readonly placeholder: string
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight: number
  readonly contentInsetVertical: number
  readonly singleLineCentered: boolean
  readonly editable: boolean
  readonly scrollEnabled: boolean
  readonly autoFocus: boolean
  readonly autoCorrect: boolean
  readonly spellCheck: boolean
  readonly onComposerChange: (event: NativeEditorEvent) => void
  readonly onComposerSelectionChange?: (event: NativeSelectionEvent) => void
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void
  readonly onComposerFocus?: () => void
  readonly onComposerBlur?: () => void
  readonly onComposerContentSizeChange?: (event: NativeSyntheticEvent<{ height: number }>) => void
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME)

/**
 * Owns the mutable revision history exchanged with the native editor. Reads are stable during
 * render; writes happen only from native event handlers or post-commit effects.
 */
class ComposerNativeEventHistory {
  private renderedSequence = 0
  private snapshots: ComposerNativeEventSnapshot[]

  constructor(initialSnapshot: ComposerNativeEventSnapshot) {
    this.snapshots = [initialSnapshot]
  }

  includesUncommittedEvent(sequence: number) {
    return sequence !== this.renderedSequence
  }

  readSnapshots() {
    return this.snapshots
  }

  markRendered(sequence: number) {
    this.renderedSequence = sequence
  }

  append(snapshot: ComposerNativeEventSnapshot) {
    this.snapshots.push(snapshot)
  }

  prune(acknowledgedEventCount: number) {
    this.snapshots = pruneAcknowledgedComposerNativeEvents(this.snapshots, acknowledgedEventCount)
  }
}

export function ComposerEditor({
  ref,
  skills: _skills = EMPTY_SKILLS,
  selection,
  style,
  textStyle,
  onChangeText,
  onSelectionChange,
  onPasteImages,
  onFocus,
  onBlur,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps) {
  const nativeRef = useRef<NativeComposerEditorRef>(null)
  const mostRecentEventCountRef = useRef(0)
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0)
  const [nativeEventSequence, setNativeEventSequence] = useState(0)
  const [nativeEventHistory] = useState(
    () =>
      new ComposerNativeEventHistory({
        eventCount: 0,
        value: props.value,
        selection: selection ?? null,
      }),
  )
  const textColor = useThemeColor('--color-foreground')
  const placeholderColor = useThemeColor('--color-placeholder')
  const chipBackground = useThemeColor('--color-subtle')
  const chipBorder = useThemeColor('--color-border')
  const chipText = useThemeColor('--color-foreground')
  const skillBackground = useThemeColor('--color-inline-skill-background')
  const skillBorder = useThemeColor('--color-inline-skill-border')
  const skillText = useThemeColor('--color-inline-skill-foreground')
  const fileTint = useThemeColor('--color-icon-muted')

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const current = nativeRef.current
        if (current !== null) void current.focus()
      },
      blur: () => {
        const current = nativeRef.current
        if (current !== null) void current.blur()
      },
      setSelection: (nextSelection) => {
        const current = nativeRef.current
        if (current !== null) void current.setSelection(nextSelection.start, nextSelection.end)
      },
    }),
    [],
  )

  // Vivid sends plain text; T3 file/skill chips are not exposed by its API.
  const tokensJson = '[]'
  const nativeEventSnapshots = nativeEventHistory.readSnapshots()
  const includesNativeEvent = nativeEventHistory.includesUncommittedEvent(nativeEventSequence)
  const controlledEventCount = includesNativeEvent
    ? resolveComposerControlledEventCount(
        props.value,
        selection ?? null,
        mostRecentEventCount,
        nativeEventSnapshots,
      )
    : mostRecentEventCount
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshots,
  )
  const isNativeEcho =
    includesNativeEvent &&
    controlledEventCount === mostRecentEventCount &&
    acknowledgesLatestNativeEvent
  const controlledDocumentJson = JSON.stringify({
    value: props.value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  })
  useEffect(() => {
    nativeEventHistory.markRendered(nativeEventSequence)
  }, [nativeEventHistory, nativeEventSequence])
  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return
    nativeEventHistory.prune(mostRecentEventCount)
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount, nativeEventHistory])
  const acceptNativeEvent = useCallback(
    (eventCount: number, value: string, nextSelection: ComposerEditorSelection) => {
      const acknowledgedEventCount = acknowledgeComposerNativeEvent(
        mostRecentEventCountRef.current,
        eventCount,
      )
      if (acknowledgedEventCount === null) {
        return false
      }
      mostRecentEventCountRef.current = acknowledgedEventCount
      nativeEventHistory.append({
        eventCount: acknowledgedEventCount,
        value,
        selection: nextSelection,
      })
      return acknowledgedEventCount
    },
    [nativeEventHistory],
  )
  const themeJson = JSON.stringify({
    text: composerColor(textColor, Platform.OS),
    placeholder: composerColor(placeholderColor, Platform.OS),
    chipBackground: composerColor(chipBackground, Platform.OS),
    chipBorder: composerColor(chipBorder, Platform.OS),
    chipText: composerColor(chipText, Platform.OS),
    skillBackground: composerColor(skillBackground, Platform.OS),
    skillBorder: composerColor(skillBorder, Platform.OS),
    skillText: composerColor(skillText, Platform.OS),
    fileTint: composerColor(fileTint, Platform.OS),
  })
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {}
  const regularFontFamily = useFontFamily('regular')
  return (
    <View style={[{ minHeight: 0 }, style]}>
      <NativeView
        ref={nativeRef}
        controlledDocumentJson={controlledDocumentJson}
        themeJson={themeJson}
        placeholder={props.placeholder ?? ''}
        fontFamily={resolvedTextStyle.fontFamily ?? regularFontFamily}
        fontSize={resolvedTextStyle.fontSize ?? MOBILE_TYPOGRAPHY.body.fontSize}
        lineHeight={resolvedTextStyle.lineHeight ?? MOBILE_TYPOGRAPHY.body.lineHeight}
        contentInsetVertical={contentInsetVertical}
        singleLineCentered={props.singleLineCentered ?? false}
        editable={props.editable ?? true}
        scrollEnabled={props.scrollEnabled ?? true}
        autoFocus={props.autoFocus ?? false}
        autoCorrect={props.autoCorrect ?? true}
        spellCheck={props.spellCheck ?? true}
        style={{ flex: 1, minHeight: 0 }}
        onComposerChange={(event) => {
          const acknowledgedEventCount = acceptNativeEvent(
            event.nativeEvent.eventCount,
            event.nativeEvent.value,
            event.nativeEvent.selection,
          )
          if (acknowledgedEventCount === false) return
          onChangeText(event.nativeEvent.value)
          if (onSelectionChange !== undefined) onSelectionChange(event.nativeEvent.selection)
          setMostRecentEventCount(acknowledgedEventCount)
          setNativeEventSequence((sequence) => sequence + 1)
        }}
        onComposerSelectionChange={(event) => {
          const acknowledgedEventCount = acceptNativeEvent(
            event.nativeEvent.eventCount,
            event.nativeEvent.value,
            event.nativeEvent.selection,
          )
          if (acknowledgedEventCount === false) return
          if (onSelectionChange !== undefined) onSelectionChange(event.nativeEvent.selection)
          setMostRecentEventCount(acknowledgedEventCount)
          setNativeEventSequence((sequence) => sequence + 1)
        }}
        onComposerPasteImages={(event) => {
          if (onPasteImages !== undefined) onPasteImages(event.nativeEvent.uris)
        }}
        onComposerFocus={onFocus}
        onComposerBlur={onBlur}
        onComposerContentSizeChange={(event) => {
          if (props.onContentHeightChange !== undefined)
            props.onContentHeightChange(event.nativeEvent.height)
        }}
      />
    </View>
  )
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from './T3ComposerEditor.types'
