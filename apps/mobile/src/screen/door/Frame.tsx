import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useNavigation } from '@react-navigation/native'
import { Option } from 'effect'
import { createContext, useContext, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import type { ServerAddress } from '../../data/server'
import { useTheme } from '../../theme'
import { Glass } from '../../ui/Glass'
import { AboveKeyboard } from '../../ui/Keyboard'
import { GUTTER, Label, Press, TARGET } from '../../ui/ui'

/**
 * The front door's steps, each its own screen on one native stack, so going on is the platform's
 * push and going back is its pop and its back swipe.
 *
 * - `Welcome`: Vivid and the way in.
 * - `Email`, then `Password`: signing in. The email travels to the next step.
 * - `Create`: a new account, asking only a name and a password for that email.
 * - `Code`: signing in with a code entered on a device that is already signed in.
 * - `Google`: signing in with Google, in the browser, which then lets this phone in.
 * - `Address`: where this phone's Vivid is. Development builds only.
 */
export type DoorRoutes = {
  Welcome: undefined
  Email: undefined
  Password: { email: string }
  Create: { email: string }
  Code: undefined
  Google: undefined
  Address: undefined
}

export const useDoorGo = () => useNavigation<NativeStackNavigationProp<DoorRoutes>>()

/**
 * What every step is given from above the stack (`Door.tsx`): the Vivid it signs in to, decided
 * once so no step asks for it, and the sentence said on Welcome when a session was ended
 * elsewhere. `null` is the value outside the stack, where no step is drawn.
 */
export interface Entrance {
  readonly server: ServerAddress
  readonly ended: Option.Option<string>
}
const EntranceContext = createContext<Entrance | null>(null)
export const EntranceProvider = EntranceContext.Provider
export function useEntrance(): Entrance {
  const entrance = useContext(EntranceContext)
  if (entrance === null) throw new Error('This step is drawn outside the front door.')
  return entrance
}
export const useServer = (): ServerAddress => useEntrance().server

/** The way back, on a round of glass at the top of a step. The system's back swipe works too. */
function Back() {
  const go = useDoorGo()
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={go.goBack}
      containerStyle={{ alignSelf: 'flex-start' }}
    >
      <Glass radius={TARGET / 2}>
        <View
          style={{ width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' }}
        >
          <ChevronLeft pointerEvents="none" size={22} strokeWidth={2} color={c.foreground} />
        </View>
      </Glass>
    </Press>
  )
}

/**
 * The layout every step after the first is drawn in: the way back, what is being asked, the
 * field, and at the foot the one button.
 *
 * The field is at the top of the screen and the button is outside the scrolling part, resting on
 * the keyboard (`AboveKeyboard`), so neither can be covered by it however tall the keyboard or
 * however large the text. The steps draw their own bar instead of the native one for that
 * reason: a native bar above a keyboard-avoiding view shifts its measure by the bar's height,
 * which cannot be checked without a device, and a covered button is the worse fault.
 */
export function Step({
  title,
  lead,
  children,
  foot,
}: {
  title: string
  lead?: string
  children: ReactNode
  foot: ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <AboveKeyboard>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: insets.top + 8,
          paddingHorizontal: GUTTER,
          paddingBottom: 16,
        }}
      >
        <View style={{ width: '100%', maxWidth: 440, alignSelf: 'center' }}>
          <Back />
          <Label accessibilityRole="header" size="display" style={{ marginTop: 28 }}>
            {title}
          </Label>
          {lead !== undefined && (
            <Label tone="ink-2" style={{ marginTop: 8 }}>
              {lead}
            </Label>
          )}
          <View style={{ marginTop: 24, gap: 14 }}>{children}</View>
        </View>
      </ScrollView>
      <View
        style={{
          paddingHorizontal: GUTTER,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 12),
          gap: 4,
        }}
      >
        <View style={{ width: '100%', maxWidth: 440, alignSelf: 'center', gap: 4 }}>{foot}</View>
      </View>
    </AboveKeyboard>
  )
}

/**
 * A field with what is wrong with it said directly under it. The sentence is the signal and is
 * read out as soon as it appears; nothing else on the screen changes colour to say it.
 */
export function Asked({
  problem,
  children,
}: {
  problem: Option.Option<string>
  children: ReactNode
}) {
  return (
    <View style={{ gap: 8 }}>
      {children}
      {Option.isSome(problem) && (
        <Label accessibilityLiveRegion="polite" size="label" tone="status-danger">
          {problem.value}
        </Label>
      )}
    </View>
  )
}

/** A lesser way on: words alone, in the theme's primary, with a full-height target. */
export function Quiet({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TARGET,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: TARGET / 2,
        backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
      })}
    >
      <Label size="footnote" tone="accent-ink">
        {label}
      </Label>
    </Press>
  )
}
