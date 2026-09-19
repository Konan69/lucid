import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated'
import { suggestions } from '../../../web/src/data/fixtures'
import { nativeMetrics as m } from '@vivid/design-tokens/native'
import { MotionPressable } from '../components/MotionPressable'
import { ChatComposer, ChatHeader, useChatKeyboard } from '../components/ChatChrome'
import { Face, Feedback, Label } from '../components/ui'
import { useTheme } from '../theme'
import { useWorkspace, type Routes } from '../workspace'

export function Welcome({ navigation }: NativeStackScreenProps<Routes, 'Home'>) {
  const { createThread } = useWorkspace()
  const { colors: c } = useTheme()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [focus, setFocus] = useState(0)
  const keyboard = useChatKeyboard()
  async function send() {
    if (!draft.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const thread = await createThread(draft.trim())
      navigation.navigate('Chat', { ...thread, sendOnOpen: true })
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      enabled={Platform.OS !== 'android' || keyboard}
    >
      <ChatHeader fresh />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: 24,
          paddingVertical: 28,
        }}
      >
        <Animated.View
          entering={FadeInDown.duration(180).reduceMotion(ReduceMotion.System)}
          style={{ width: '100%', maxWidth: 520, alignSelf: 'center', alignItems: 'center' }}
        >
          <Face size={keyboard ? 40 : 56} mood={keyboard ? 'thinking' : 'happy'} />
          <Label
            size="largeTitle"
            style={{ marginTop: 20, fontWeight: '500', textAlign: 'center' }}
          >
            Hi, I'm Vivid.
          </Label>
          <Label tone="ink-3" style={{ marginTop: 4, fontWeight: '400', textAlign: 'center' }}>
            What should I take off your plate?
          </Label>
          {!keyboard && (
            <View style={{ width: '100%', marginTop: 32, gap: 8 }}>
              {suggestions.map((suggestion) => (
                <MotionPressable
                  key={suggestion}
                  accessibilityRole="button"
                  onPress={() => {
                    setDraft(suggestion)
                    setFocus((n) => n + 1)
                  }}
                  style={({ pressed }) => ({
                    minHeight: 56,
                    justifyContent: 'center',
                    padding: 16,
                    borderRadius: m['radius-card'] * m['phone-radius-factor'],
                    backgroundColor: pressed ? c['wash-hover'] : c['surface-3'],
                    borderWidth: 0.5,
                    borderColor: c['line-2'],
                  })}
                >
                  <Label tone="ink-2" size="label" style={{ fontWeight: '400', lineHeight: 20 }}>
                    {suggestion}
                  </Label>
                </MotionPressable>
              ))}
            </View>
          )}
        </Animated.View>
      </ScrollView>
      {!!error && (
        <View style={{ paddingHorizontal: 24 }}>
          <Feedback error={error} />
        </View>
      )}
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        disabled={busy}
        keyboardVisible={keyboard}
        focusRequest={focus}
      />
    </KeyboardAvoidingView>
  )
}
