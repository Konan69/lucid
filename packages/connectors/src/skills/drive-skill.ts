import { getConnectorStatus } from '../store.ts'
import { DriveConnector } from '../google/drive.ts'
import { bindConnectorTools } from './bind.ts'

const connector = new DriveConnector()

/** Registers Drive tools synchronously and loads credentials only at invocation. */
export function driveTools() {
  return bindConnectorTools('drive', 'Google Drive', connector.tools())
}

/** Reads the current Drive Connection state. */
export async function driveStatus() {
  return getConnectorStatus('drive')
}
