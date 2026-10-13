import { nativeTheme } from 'electron'
import { ColorSchemeState, type ColorSchemePreference } from '../shared/bridge.ts'
import { inkFor, surfaceFor, type ThemeSurfaces } from './tokens.ts'

/**
 * Owns the native theme subscription for the lifetime of the Electron process. Window paint values
 * come from shared design tokens, while bridge state comes from Electron's typed nativeTheme API.
 */
export class ColorSchemeController {
  private readonly listeners = new Set<(state: ColorSchemeState) => void>()

  constructor(private readonly surfaces: ThemeSurfaces) {
    nativeTheme.on('updated', () => {
      const state = this.getState()
      for (const listener of this.listeners) listener(state)
    })
  }

  /** Capture preference and resolution together so listeners never observe a split update. */
  getState(): ColorSchemeState {
    return ColorSchemeState.make({
      preference: nativeTheme.themeSource,
      resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    })
  }

  /**
   * Adopt the look the Person chose in Vivid as the window's own scheme. Until the page says one,
   * the scheme is the operating system's, and a Person who chose light on a dark system got dark
   * window buttons on a black strip over a light page (seen on Windows, 13 October 2026).
   * Electron then reports `updated`, so every window repaints through `onChange` as it does for
   * a change made in the system. Setting the scheme it already has reports nothing.
   *
   * The mechanism is T3 Code's (`setSource` in `apps/desktop/src/electron/ElectronTheme.ts`).
   */
  show(preference: ColorSchemePreference): void {
    nativeTheme.themeSource = preference
  }
  /** Subscribe one window and return the exact cleanup operation for its close event. */
  onChange(listener: (state: ColorSchemeState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Resolve the native background from the same state sent to the renderer. */
  background(): string {
    return surfaceFor(this.surfaces, this.getState().resolved)
  }

  /** Resolve a solid title-bar glyph color for Windows' native overlay. */
  overlaySymbolColor(): string {
    return inkFor(this.surfaces, this.getState().resolved)
  }
}
