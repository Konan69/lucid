import { nativeTheme } from 'electron'
import { ColorSchemeState } from '../shared/bridge.ts'
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
