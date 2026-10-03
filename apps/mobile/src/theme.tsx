import { nativeThemes } from '@vivid/tokens/native'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'
import { familyAtom, paletteOf, themeAtom } from './data/appearance'
import { useDoor } from './data/door'

export type Colors = { [K in keyof typeof nativeThemes.graphite.dark]: string }

const ThemeContext = createContext<{ colors: Colors; dark: boolean }>({
  colors: nativeThemes.graphite.light,
  dark: false,
})

/**
 * Hands every component the palette in force. It reads three things and owns none: the Person's
 * choice of light or dark (`themeAtom`), their theme family (`familyAtom`) and what the system is
 * showing (`useColorScheme`, which React
 * Native keeps current). Telling the system about a choice and painting the window behind the app
 * happen where the choice changes, in `data/appearance.ts`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const palette = paletteOf(useDoor(themeAtom), useColorScheme())
  const family = useDoor(familyAtom)
  const contextValue = useMemo(
    () => ({ colors: nativeThemes[family][palette], dark: palette === 'dark' }),
    [family, palette],
  )
  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
