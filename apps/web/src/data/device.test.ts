import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { deviceName } from './device'

const named = (agent: string) => deviceName(Option.some(agent))

describe('what a signed-in device is called', () => {
  it('names the browser and the computer it runs on', () => {
    expect(
      named(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on Mac')
    expect(
      named(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      ),
    ).toBe('Edge on Windows')
    expect(
      named(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone')
  })

  it('names the Vivid apps as themselves', () => {
    expect(
      named(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Vivid/1.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
      ),
    ).toBe('Vivid desktop app on Mac')
    expect(named('okhttp/4.12.0')).toBe('Vivid on Android')
    expect(named('Vivid/1 CFNetwork/1568.100.1 Darwin/24.0.0')).toBe('Vivid on iPhone')
  })

  it('still lists what it cannot recognise', () => {
    expect(named('curl/8.5.0')).toBe('A device')
    expect(deviceName(Option.none())).toBe('A device')
  })
})
