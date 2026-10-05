import type { Session } from 'electron'
import type { ServerSettings } from '../shared/settings.ts'
import { isAllowedPermission, isAllowedResponse, isAppRequest } from './security.ts'

/**
 * The Chromium partition the app's own window lives in: its cookies, its storage and the requests
 * `secureSession` guards. Named once, because error reporting has to answer in the same one
 * (`telemetry.ts`).
 */
export const APP_PARTITION = 'persist:vivid'

/**
 * One app session owns both request and permission checks. Block foreign network requests,
 * including redirected uploads and WebSockets, before sending headers. Response guards reject
 * foreign Location headers before Chromium follows them, including cookie-aware session.fetch.
 */
export function secureSession(desktopSession: Session, server: () => ServerSettings): void {
  desktopSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => callback({ cancel: !isAppRequest(details.url, server()) }),
  )
  desktopSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders === undefined ? {} : details.responseHeaders
    callback({
      cancel: !isAllowedResponse({
        url: details.url,
        status: details.statusCode,
        headers,
        server: server(),
      }),
    })
  })
  desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      isAllowedPermission(permission, details.requestingUrl, server()) &&
        isAppRequest(contents.getURL(), server()),
    )
  })
  desktopSession.setPermissionCheckHandler(
    (contents, permission, origin) =>
      contents !== null &&
      isAppRequest(contents.getURL(), server()) &&
      isAllowedPermission(permission, origin, server()),
  )
}
