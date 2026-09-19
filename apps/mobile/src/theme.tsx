import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { Appearance, Platform, useColorScheme } from 'react-native'
import { nativeTokens } from '@vivid/design-tokens/native'
import * as SystemUI from 'expo-system-ui'
export type ThemePreference = 'system' | 'light' | 'dark'
type Colors = { [K in keyof typeof nativeTokens.dark]: string }
const ThemeContext = createContext<{ colors: Colors; dark: boolean }>({
  colors: nativeTokens.light,
  dark: false,
})
export function ThemeProvider({
  preference,
  children,
}: {
  preference: ThemePreference
  children: ReactNode
}) {
  useEffect(() => {
    if (Platform.OS !== 'web')
      Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference)
  }, [preference])
  const system = useColorScheme()
  const mode = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(nativeTokens[mode]['surface-0'])
  }, [mode])
  return (
    <ThemeContext.Provider value={{ colors: nativeTokens[mode], dark: mode === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  )
}
export const useTheme = () => useContext(ThemeContext)
