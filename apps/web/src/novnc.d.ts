/**
 * The part of noVNC's RFB client this app uses. The package ships no types; these are the
 * constructor and the three properties the Computer panel sets, checked against `core/rfb.js` at
 * the pinned version. It is an `EventTarget`: `connect` fires once the first handshake is done and
 * `disconnect` whenever the socket closes, whether or not it ever connected.
 */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, address: string, options?: { readonly shared?: boolean })
    /** When true the canvas shows the screen and sends no keys or pointer events. */
    viewOnly: boolean
    /** Fits the remote screen to the element instead of showing it at its own size. */
    scaleViewport: boolean
    /** The CSS background behind the remote screen. */
    background: string
    disconnect(): void
  }
}
