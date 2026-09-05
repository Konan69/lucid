import { requireNativeView } from "expo";
import { Platform, View } from "react-native";
import { composerColor } from "./composerColor";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { StyleSheet } from "react-native";

import { MOBILE_TYPOGRAPHY } from "../lib/typography";

import { useFontFamily } from "../lib/useFontFamily";
import { useThemeColor } from "../lib/useThemeColor";
import {
  acknowledgeComposerNativeEvent,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";
import type { ComposerEditorProps, ComposerEditorSelection } from "./T3ComposerEditor.types";

const NATIVE_MODULE_NAME = "T3ComposerEditor";
const EMPTY_SKILLS: NonNullable<ComposerEditorProps["skills"]> = [];

type NativeEditorEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

type NativeSelectionEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

type NativePasteImagesEvent = NativeSyntheticEvent<{
  readonly uris: ReadonlyArray<string>;
}>;

interface NativeComposerEditorRef {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  setSelection: (start: number, end: number) => Promise<void>;
}

interface NativeComposerEditorProps extends ViewProps {
  readonly ref?: Ref<NativeComposerEditorRef>;
  readonly controlledDocumentJson: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly singleLineCentered: boolean;
  readonly editable: boolean;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  readonly onComposerSelectionChange?: (event: NativeSelectionEvent) => void;
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void;
  readonly onComposerFocus?: () => void;
  readonly onComposerBlur?: () => void;
  readonly onComposerContentSizeChange?: (event: NativeSyntheticEvent<{ height: number }>) => void;
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME);

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
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [nativeEventSequence, setNativeEventSequence] = useState(0);
  const previousRenderedEventSequenceRef = useRef(0);
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([
    { eventCount: 0, value: props.value, selection: selection ?? null },
  ]);
  const textColor = useThemeColor("--color-foreground");
  const placeholderColor = useThemeColor("--color-placeholder");
  const chipBackground = useThemeColor("--color-subtle");
  const chipBorder = useThemeColor("--color-border");
  const chipText = useThemeColor("--color-foreground");
  const skillBackground = useThemeColor("--color-inline-skill-background");
  const skillBorder = useThemeColor("--color-inline-skill-border");
  const skillText = useThemeColor("--color-inline-skill-foreground");
  const fileTint = useThemeColor("--color-icon-muted");

  useImperativeHandle(
    ref,
    () => ({
      focus: () => void nativeRef.current?.focus(),
      blur: () => void nativeRef.current?.blur(),
      setSelection: (nextSelection) =>
        void nativeRef.current?.setSelection(nextSelection.start, nextSelection.end),
    }),
    [],
  );

  // Vivid sends plain text; T3 file/skill chips are not exposed by its API.
  const tokensJson = "[]";
  const includesNativeEvent = nativeEventSequence !== previousRenderedEventSequenceRef.current;
  const controlledEventCount = includesNativeEvent
    ? resolveComposerControlledEventCount(
        props.value,
        selection ?? null,
        mostRecentEventCount,
        nativeEventSnapshotsRef.current,
      )
    : mostRecentEventCount;
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  const isNativeEcho =
    includesNativeEvent &&
    controlledEventCount === mostRecentEventCount &&
    acknowledgesLatestNativeEvent;
  const controlledDocumentJson = JSON.stringify({
    value: props.value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });
  useEffect(() => {
    previousRenderedEventSequenceRef.current = nativeEventSequence;
  }, [nativeEventSequence]);
  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;
    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(
      nativeEventSnapshotsRef.current,
      mostRecentEventCount,
    );
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount]);
  const acceptNativeEvent = useCallback(
    (eventCount: number, value: string, nextSelection: ComposerEditorSelection) => {
      const acknowledgedEventCount = acknowledgeComposerNativeEvent(
        mostRecentEventCountRef.current,
        eventCount,
      );
      if (acknowledgedEventCount === null) {
        return false;
      }
      mostRecentEventCountRef.current = acknowledgedEventCount;
      nativeEventSnapshotsRef.current.push({
        eventCount: acknowledgedEventCount,
        value,
        selection: nextSelection,
      });
      return acknowledgedEventCount;
    },
    [],
  );
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
  });
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  const regularFontFamily = useFontFamily("regular");
  return (
    <View style={[{ minHeight: 0 }, style]}>
      <NativeView
        ref={nativeRef}
        controlledDocumentJson={controlledDocumentJson}
        themeJson={themeJson}
        placeholder={props.placeholder ?? ""}
        fontFamily={
          typeof resolvedTextStyle.fontFamily === "string"
            ? resolvedTextStyle.fontFamily
            : regularFontFamily
        }
        fontSize={
          typeof resolvedTextStyle.fontSize === "number"
            ? resolvedTextStyle.fontSize
            : MOBILE_TYPOGRAPHY.body.fontSize
        }
        lineHeight={
          typeof resolvedTextStyle.lineHeight === "number"
            ? resolvedTextStyle.lineHeight
            : MOBILE_TYPOGRAPHY.body.lineHeight
        }
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
          );
          if (acknowledgedEventCount === false) return;
          onChangeText(event.nativeEvent.value);
          onSelectionChange?.(event.nativeEvent.selection);
          setMostRecentEventCount(acknowledgedEventCount);
          setNativeEventSequence((sequence) => sequence + 1);
        }}
        onComposerSelectionChange={(event) => {
          const acknowledgedEventCount = acceptNativeEvent(
            event.nativeEvent.eventCount,
            event.nativeEvent.value,
            event.nativeEvent.selection,
          );
          if (acknowledgedEventCount === false) return;
          onSelectionChange?.(event.nativeEvent.selection);
          setMostRecentEventCount(acknowledgedEventCount);
          setNativeEventSequence((sequence) => sequence + 1);
        }}
        onComposerPasteImages={(event) => onPasteImages?.(event.nativeEvent.uris)}
        onComposerFocus={onFocus}
        onComposerBlur={onBlur}
        onComposerContentSizeChange={(event) =>
          props.onContentHeightChange?.(event.nativeEvent.height)
        }
      />
    </View>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";
