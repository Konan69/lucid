/** Compare only the fixed magic bytes; full image parsing remains the model provider's responsibility. */
function begins(bytes: readonly number[], signature: readonly number[]) {
  return signature.every((byte, index) => bytes[index] === byte)
}

/** SVG and open image/* types are unsupported. A declaration must agree with its binary signature. */
export function imageMatches(bytes: readonly number[], mediaType: string): boolean {
  switch (mediaType) {
    case 'image/png':
      return begins(bytes, [137, 80, 78, 71, 13, 10, 26, 10])
    case 'image/jpeg':
      return begins(bytes, [255, 216, 255])
    case 'image/gif':
      return (
        begins(bytes, [71, 73, 70, 56]) && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97
      )
    case 'image/webp':
      return begins(bytes, [82, 73, 70, 70]) && begins(bytes.slice(8), [87, 69, 66, 80])
    default:
      return false
  }
}
