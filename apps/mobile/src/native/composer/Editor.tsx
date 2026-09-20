import { View } from 'react-native'
import { useImperativeHandle, useRef } from 'react'
import { TextInput, type TextInput as RNTextInput } from 'react-native'

import { useThemeColor } from '../../data/color'
import { useFontFamily } from '../../data/font'
import { MOBILE_TYPOGRAPHY } from '../../data/typography'

import type { ComposerEditorProps } from './types'

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
  const inputRef = useRef<RNTextInput>(null)
  const bodyText = MOBILE_TYPOGRAPHY.body
  const foregroundColor = useThemeColor('--color-foreground')
  const placeholderColor = useThemeColor('--color-placeholder')
  const fontFamily = useFontFamily('regular')

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const input = inputRef.current
        if (input !== null) input.focus()
      },
      blur: () => {
        const input = inputRef.current
        if (input !== null) input.blur()
      },
      setSelection: (nextSelection) => {
        const input = inputRef.current
        if (input !== null) input.setSelection(nextSelection.start, nextSelection.end)
      },
    }),
    [],
  )

  return (
    <View style={[{ minHeight: 0 }, style]}>
      <TextInput
        ref={inputRef}
        {...props}
        selection={selection}
        onSelectionChange={(event) => {
          if (props.onSelectionChange !== undefined)
            props.onSelectionChange(event.nativeEvent.selection)
        }}
        multiline={props.multiline ?? true}
        onContentSizeChange={(event) => {
          if (onContentHeightChange !== undefined)
            onContentHeightChange(event.nativeEvent.contentSize.height)
        }}
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
  )
}

export type { ComposerEditorHandle, ComposerEditorProps, ComposerEditorSelection } from './types'
