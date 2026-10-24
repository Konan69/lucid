import * as NodeAssert from 'node:assert/strict'

/** A headless, dependency-free CDP client; it drives Chromium input, never app internals. */
export async function connect(address) {
  const socket = new WebSocket(address)
  const pending = new Map()
  const listeners = new Set()
  let sequence = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    } else for (const listener of listeners) listener(message)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      if (request.method === 'Browser.close') request.resolve({})
      else request.reject(new Error('CDP disconnected during ' + request.method))
    }
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('CDP deadline: ' + method))
        }, 120_000)
        pending.set(id, { resolve, reject, timer, method })
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      })
    },
    /** Subscribe before the action so even an immediate native receipt is retained. */
    hear(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      socket.close()
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('CDP closed'))
      }
      pending.clear()
    },
  }
}

/** Select only this Electron app's renderer; child guest pages remain the app's responsibility. */
export async function renderer(browser) {
  const targets = new Map()
  let changed = () => {}
  const unlisten = browser.hear((event) => {
    if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') {
      targets.set(event.params.targetInfo.targetId, event.params.targetInfo)
      changed()
    }
  })
  try {
    await browser.send('Target.setDiscoverTargets', { discover: true })
    const target = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No Electron renderer')), 120_000)
      changed = () => {
        const found = [...targets.values()].find((t) => t.type === 'page' && t.url !== '')
        if (!found) return
        clearTimeout(timer)
        resolve(found)
      }
      changed()
    })
    const { sessionId } = await browser.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    const send = (method, params) => browser.send(method, params, sessionId)
    await send('Runtime.enable')
    await send('Page.enable')
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      NodeAssert.equal(result.exceptionDetails, undefined, 'Renderer expression failed')
      return result.result.value
    }
    return {
      send,
      evaluate,
      /** Navigation destroys the old execution context; wait for the new document's load receipt. */
      async navigate(action) {
        let stop = () => {}
        let timer
        const loaded = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Navigation deadline')), 120_000)
          stop = browser.hear((event) => {
            if (event.sessionId === sessionId && event.method === 'Page.loadEventFired') resolve()
          })
        })
        void loaded.catch(() => {})
        try {
          await action()
          await loaded
        } finally {
          clearTimeout(timer)
          stop()
        }
      },
    }
  } finally {
    unlisten()
  }
}

/** A DOM publication, including React replacing a form, is the wait signal; time never means ready. */
export async function wait(page, expression) {
  return page.evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('DOM deadline')) }, 90000)
    const check = () => {
      if (!(${expression})) return
      observer.disconnect(); clearTimeout(timer); resolve(true)
    }
    const observer = new MutationObserver(check)
    observer.observe(document, { subtree: true, childList: true, attributes: true })
    check()
  })`)
}

/** Resolve the visible control, then deliver real mouse input through Chromium. */
export async function click(page, expression) {
  await wait(page, expression)
  const point = await page.evaluate(`(() => {
    const element = (${expression}); element.scrollIntoView({ block: 'center' })
    const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}

/** Input.insertText uses Chromium's editing path, so React receives the normal input event. */
export async function fill(page, selector, text) {
  await click(page, `document.querySelector(${JSON.stringify(selector)})`)
  await page.send('Input.insertText', { text })
}

export const button = (name) =>
  `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(name)})`
