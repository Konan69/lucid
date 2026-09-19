// T3's native parsers accept hex, not React Native rgb()/rgba() strings.
// Android Color.parseColor uses AARRGGBB; T3's Swift parser uses RRGGBBAA.
export function composerColor(value: string, platform: string): string {
  let rgba: string
  if (/^#[\da-f]{6}$/i.test(value)) return value
  if (/^#[\da-f]{8}$/i.test(value)) rgba = value.slice(1)
  else {
    const rgb = value.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/)
    if (!rgb) throw new Error(`Unsupported composer color: ${value}`)
    const byte = (n: number) =>
      Math.round(Math.max(0, Math.min(255, n)))
        .toString(16)
        .padStart(2, '0')
    const channels = rgb
      .slice(1, 4)
      .map((n) => byte(Number(n)))
      .join('')
    if (rgb[4] === undefined) return '#' + channels
    rgba = channels + byte(Number(rgb[4]) * 255)
  }
  return '#' + (platform === 'android' ? rgba.slice(6) + rgba.slice(0, 6) : rgba)
}
