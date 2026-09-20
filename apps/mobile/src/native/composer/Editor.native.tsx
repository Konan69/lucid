import { requireNativeView } from 'expo'
import { Platform, View } from 'react-native'
import { composerColor } from './color'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Dispatch,
  type Ref,
  type RefObject,
  type SetStateAction,
} from 'react'
import type { NativeSyntheticEvent, TextStyle, ViewProps } from 'react-native'
import { StyleSheet } from 'react-native'

import { MOBILE_TYPOGRAPHY } from '../../lib/typography'

import { useFontFamily } from '../../lib/font'
import { useThemeColor } from '../../lib/color'
import {
  acknowledgeComposerNativeEvent,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from './revision'
import type { ComposerEditorProps, ComposerEditorSelection } from './types'

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

type ControlledDocumentInput = {
  readonly value: string
  readonly selection: ComposerEditorSelection | null
  readonly mostRecentEventCount: number
  readonly includesNativeEvent: boolean
  readonly snapshots: readonly ComposerNativeEventSnapshot[]
}

/** Derives the controlled payload and acknowledgement state from one revision snapshot. */
function deriveControlledDocument(input: ControlledDocumentInput) {
  const controlledEventCount = input.includesNativeEvent
    ? resolveComposerControlledEventCount(
        input.value,
        input.selection,
        input.mostRecentEventCount,
        input.snapshots,
      )
    : input.mostRecentEventCount
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    input.value,
    input.selection,
    input.mostRecentEventCount,
    input.snapshots,
  )
  const isNativeEcho =
    input.includesNativeEvent &&
    controlledEventCount === input.mostRecentEventCount &&
    acknowledgesLatestNativeEvent

  return {
    acknowledgesLatestNativeEvent,
    json: JSON.stringify({
      value: input.value,
      selection: isNativeEcho ? null : input.selection,
      tokensJson: '[]',
      mostRecentEventCount: controlledEventCount,
      isNativeEcho,
    }),
  }
}

/** Reads theme hooks once and serializes the native editor palette. */
function useComposerThemeJson() {
  const textColor = useThemeColor('--color-foreground')
  const placeholderColor = useThemeColor('--color-placeholder')
  const chipBackground = useThemeColor('--color-subtle')
  const chipBorder = useThemeColor('--color-border')
  const chipText = useThemeColor('--color-foreground')
  const skillBackground = useThemeColor('--color-inline-skill-background')
  const skillBorder = useThemeColor('--color-inline-skill-border')
  const skillText = useThemeColor('--color-inline-skill-foreground')
  const fileTint = useThemeColor('--color-icon-muted')

  return JSON.stringify({
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
}

type NativeViewConfigurationInput = Pick<
  ComposerEditorProps,
  | 'placeholder'
  | 'singleLineCentered'
  | 'editable'
  | 'scrollEnabled'
  | 'autoFocus'
  | 'autoCorrect'
  | 'spellCheck'
>

/** Resolves native defaults once so the rendered bridge receives concrete values. */
function resolveNativeViewConfiguration(
  props: NativeViewConfigurationInput,
  textStyle: TextStyle,
  regularFontFamily: string,
) {
  return {
    placeholder: props.placeholder ?? '',
    fontFamily: textStyle.fontFamily ?? regularFontFamily,
    fontSize: textStyle.fontSize ?? MOBILE_TYPOGRAPHY.body.fontSize,
    lineHeight: textStyle.lineHeight ?? MOBILE_TYPOGRAPHY.body.lineHeight,
    singleLineCentered: props.singleLineCentered ?? false,
    editable: props.editable ?? true,
    scrollEnabled: props.scrollEnabled ?? true,
    autoFocus: props.autoFocus ?? false,
    autoCorrect: props.autoCorrect ?? true,
    spellCheck: props.spellCheck ?? true,
  }
}

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

type NativeComposerViewProps = {
  readonly nativeRef: RefObject<NativeComposerEditorRef | null>
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
  readonly style: ComposerEditorProps['style']
  readonly onChangeText: ComposerEditorProps['onChangeText']
  readonly onSelectionChange: ComposerEditorProps['onSelectionChange']
  readonly onPasteImages: ComposerEditorProps['onPasteImages']
  readonly onFocus: ComposerEditorProps['onFocus']
  readonly onBlur: ComposerEditorProps['onBlur']
  readonly onContentHeightChange: ComposerEditorProps['onContentHeightChange']
  readonly acceptNativeEvent: (
    eventCount: number,
    value: string,
    nextSelection: ComposerEditorSelection,
  ) => number | false
  readonly setMostRecentEventCount: Dispatch<SetStateAction<number>>
  readonly setNativeEventSequence: Dispatch<SetStateAction<number>>
}

/** Forwards native events in their existing order while the parent owns revision state. */
function NativeComposerView({
  nativeRef,
  controlledDocumentJson,
  themeJson,
  placeholder,
  fontFamily,
  fontSize,
  lineHeight,
  contentInsetVertical,
  singleLineCentered,
  editable,
  scrollEnabled,
  autoFocus,
  autoCorrect,
  spellCheck,
  style,
  onChangeText,
  onSelectionChange,
  onPasteImages,
  onFocus,
  onBlur,
  onContentHeightChange,
  acceptNativeEvent,
  setMostRecentEventCount,
  setNativeEventSequence,
}: NativeComposerViewProps) {
  return (
    <View style={[{ minHeight: 0 }, style]}>
      <NativeView
        ref={nativeRef}
        controlledDocumentJson={controlledDocumentJson}
        themeJson={themeJson}
        placeholder={placeholder}
        fontFamily={fontFamily}
        fontSize={fontSize}
        lineHeight={lineHeight}
        contentInsetVertical={contentInsetVertical}
        singleLineCentered={singleLineCentered}
        editable={editable}
        scrollEnabled={scrollEnabled}
        autoFocus={autoFocus}
        autoCorrect={autoCorrect}
        spellCheck={spellCheck}
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
          if (onContentHeightChange !== undefined) onContentHeightChange(event.nativeEvent.height)
        }}
      />
    </View>
  )
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
  const themeJson = useComposerThemeJson()

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
  const controlledDocument = deriveControlledDocument({
    value: props.value,
    selection: selection ?? null,
    mostRecentEventCount,
    includesNativeEvent: nativeEventHistory.includesUncommittedEvent(nativeEventSequence),
    snapshots: nativeEventHistory.readSnapshots(),
  })
  const acknowledgesLatestNativeEvent = controlledDocument.acknowledgesLatestNativeEvent
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
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {}
  const regularFontFamily = useFontFamily('regular')
  const configuration = resolveNativeViewConfiguration(props, resolvedTextStyle, regularFontFamily)
  return (
    <NativeComposerView
      nativeRef={nativeRef}
      controlledDocumentJson={controlledDocument.json}
      themeJson={themeJson}
      placeholder={configuration.placeholder}
      fontFamily={configuration.fontFamily}
      fontSize={configuration.fontSize}
      lineHeight={configuration.lineHeight}
      contentInsetVertical={contentInsetVertical}
      singleLineCentered={configuration.singleLineCentered}
      editable={configuration.editable}
      scrollEnabled={configuration.scrollEnabled}
      autoFocus={configuration.autoFocus}
      autoCorrect={configuration.autoCorrect}
      spellCheck={configuration.spellCheck}
      style={style}
      onChangeText={onChangeText}
      onSelectionChange={onSelectionChange}
      onPasteImages={onPasteImages}
      onFocus={onFocus}
      onBlur={onBlur}
      onContentHeightChange={props.onContentHeightChange}
      acceptNativeEvent={acceptNativeEvent}
      setMostRecentEventCount={setMostRecentEventCount}
      setNativeEventSequence={setNativeEventSequence}
    />
  )
}

export type { ComposerEditorHandle, ComposerEditorProps, ComposerEditorSelection } from './types'
