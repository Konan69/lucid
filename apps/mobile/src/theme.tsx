import { nativeTokens } from '@vivid/tokens/native'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'
import { paletteOf, themeAtom } from './data/appearance'
import { useDoor } from './data/door'

type Colors = { [K in keyof typeof nativeTokens.dark]: string }

const ThemeContext = createContext<{ colors: Colors; dark: boolean }>({
  colors: nativeTokens.light,
  dark: false,
})

/**
 * Hands every component the palette in force. It reads two things and owns neither: the
 * Person's choice (`themeAtom`) and what the system is showing (`useColorScheme`, which React
 * Native keeps current). Telling the system about a choice and painting the window behind the app
 * happen where the choice changes, in `data/appearance.ts`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const palette = paletteOf(useDoor(themeAtom), useColorScheme())
  const contextValue = useMemo(
    () => ({ colors: nativeTokens[palette], dark: palette === 'dark' }),
    [palette],
  )
  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
