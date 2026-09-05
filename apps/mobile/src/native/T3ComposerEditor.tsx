import { View } from "react-native";
import { useImperativeHandle, useRef } from "react";
import { TextInput, type TextInput as RNTextInput } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { useFontFamily } from "../lib/useFontFamily";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";

import type { ComposerEditorProps } from "./T3ComposerEditor.types";

export function ComposerEditor({
  ref,
  skills: _skills,
  selection,
  onPasteImages: _onPasteImages,
  style,
  textStyle,
  contentInsetVertical = 0,
  singleLineCentered: _singleLineCentered,
  onContentHeightChange,
  onSubmit: _onSubmit,
  ...props
}: ComposerEditorProps) {
  const inputRef = useRef<RNTextInput>(null);
  const bodyText = MOBILE_TYPOGRAPHY.body;
  const foregroundColor = useThemeColor("--color-foreground");
  const placeholderColor = useThemeColor("--color-placeholder");
  const fontFamily = useFontFamily("regular");

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      setSelection: (nextSelection) =>
        inputRef.current?.setSelection(nextSelection.start, nextSelection.end),
    }),
    [],
  );

  return (
    <View style={[{ minHeight: 0 }, style]}>
      <TextInput
        ref={inputRef}
        {...props}
        selection={selection}
        onSelectionChange={(event) =>
          props.onSelectionChange?.(event.nativeEvent.selection)
        }
        multiline={props.multiline ?? true}
        onContentSizeChange={(event) =>
          onContentHeightChange?.(event.nativeEvent.contentSize.height)
        }
        placeholderTextColor={placeholderColor}
        style={[
          {
            flex: 1,
            minHeight: 0,
            color: foregroundColor,
            fontFamily,
            ...bodyText,
            paddingVertical: contentInsetVertical,
          },
          textStyle,
        ]}
      />
    </View>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";
