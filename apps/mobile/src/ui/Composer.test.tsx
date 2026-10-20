// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Composer, type Onward } from './Composer'

/**
 * Native host modules need a device. These DOM adapters retain press callbacks and draft props;
 * the real Composer owns all control selection. This checks interaction wiring, not native layout.
 */
/* oxlint-disable anti-slop/no-module-mocking -- Native host adapters cannot run in happy-dom; no Composer or interaction decision is replaced. */
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: () => null,
  ChevronLeft: () => null,
  Square: () => null,
}))
vi.mock('../data/haptics', () => ({ commit: () => undefined }))
vi.mock('../data/font', () => ({ useFontFamily: () => 'system' }))
vi.mock('../data/keyboard', () => ({ useKeyboardShowing: () => false }))
vi.mock('../theme', () => ({ useTheme: () => ({ colors: {} }) }))
vi.mock('../../vendor/beam', () => ({
  BorderBeam: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./elevation', () => ({ cast: () => ({}), lifted: () => ({}) }))
vi.mock('./Glass', () => ({ GLASS_SUPPORTED: false, GlassMaterial: () => null }))
vi.mock('../native/composer/Editor', () => ({
  ComposerEditor: ({ value }: { value: string }) => <textarea value={value} readOnly />,
}))
vi.mock('./ui', () => ({
  TARGET: 44,
  styles: { column: {} },
  Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Press: ({
    accessibilityLabel,
    onPress,
    disabled,
    children,
  }: {
    accessibilityLabel: string
    onPress: () => void
    disabled?: boolean
    children?: ReactNode
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}))
/* oxlint-enable anti-slop/no-module-mocking */
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

/** A controlled draft changes on the same mounted Composer, as typing changes the screen's value. */
function composing(offers: boolean) {
  const events: Array<'stop' | 'send' | 'next' | 'back'> = []
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  onTestFinished(() => {
    act(() => root.unmount())
    container.remove()
  })
  const asked: Onward = {
    first: true,
    last: true,
    offers,
    ready: false,
    onNext: () => events.push('next'),
    onBack: () => events.push('back'),
  }
  const write = (value: string) =>
    act(() =>
      root.render(
        <Composer
          value={value}
          placeholder="Message Vivid"
          autoFocus={false}
          disabled={false}
          onChange={() => undefined}
          working
          onSend={() => events.push('send')}
          onStop={() => events.push('stop')}
          asked={asked}
        />,
      ),
    )
  const press = (name: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
    if (button === null) return expect.fail(`Composer drew no ${name} control`)
    act(() => button.click())
  }
  return { events, container, write, press }
}

describe('phone Composer while Vivid works with a question open', () => {
  it.each([true, false])('keeps Stop while typing, with offered options: %s', (offers) => {
    const { events, container, write, press } = composing(offers)
    write('')
    press('Stop Vivid')
    write('Use London')
    press('Stop Vivid')

    expect(events).toEqual(['stop', 'stop'])
    const field = container.querySelector('textarea')
    if (field === null) return expect.fail('Composer drew no draft field')
    expect(field.value).toBe('Use London')
    press(offers ? 'Send' : 'Submit answers')
    expect(events).toEqual(['stop', 'stop', 'send'])
  })
})
