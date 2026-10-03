import { chromium } from 'playwright-core'

/**
 * Chromium SIGTERM can discard pending cookie writes. Its public CDP Browser.close command
 * requests a normal browser shutdown, so the entrypoint can await profile flush and process exit.
 * Verified against the image's pinned Playwright Browser.newBrowserCDPSession and CDP protocol types.
 */
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 5000 })
const session = await browser.newBrowserCDPSession()
await session.send('Browser.close')
