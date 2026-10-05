import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  NOTICE_INVOKE_CHANNEL,
  NOTICE_NAMESPACE,
  NOTICE_STATE_CHANNEL,
  NoticeRequest,
  NoticeState,
  type VividNoticeBridge,
} from '../shared/notice.ts'

/**
 * The notice window's own preload. The notice is the smallest surface in the app and gets the
 * smallest bridge: it can learn what to say and it can stop Vivid. It has none of the app
 * window's bridge (pages, the device link, opening addresses), so a fault in the notice page
 * reaches nothing else.
 */

const decodeState = Schema.decodeUnknownOption(NoticeState)
const encodeRequest = Schema.encodeSync(NoticeRequest)

const bridge: VividNoticeBridge = {
  watch: (listener) => {
    // What main sends is decoded here, once; a message that is not a state is dropped.
    const heard = (payload: typeof Schema.Unknown.Type): void => {
      Option.map(decodeState(payload), listener)
    }
    const pushed = (_event: IpcRendererEvent, payload: typeof Schema.Unknown.Type): void =>
      heard(payload)
    ipcRenderer.on(NOTICE_STATE_CHANNEL, pushed)
    // The page may finish loading after main sent the state, so it also asks once.
    void ipcRenderer
      .invoke(NOTICE_INVOKE_CHANNEL, encodeRequest(NoticeRequest.cases.State.make({})))
      .then(heard, () => undefined)
    return () => {
      ipcRenderer.removeListener(NOTICE_STATE_CHANNEL, pushed)
    }
  },
  stop: () => {
    void ipcRenderer
      .invoke(NOTICE_INVOKE_CHANNEL, encodeRequest(NoticeRequest.cases.Stop.make({})))
      .catch(() => undefined)
  },
}
contextBridge.exposeInMainWorld(NOTICE_NAMESPACE, bridge)
