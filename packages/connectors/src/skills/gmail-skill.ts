import { getConnectorStatus } from "../store.ts"
import { GmailConnector } from "../google/gmail.ts"
import { bindConnectorTools } from "./bind.ts"

const connector = new GmailConnector()

/** Registers Gmail tools synchronously and loads credentials only at invocation. */
export function gmailTools() {
  return bindConnectorTools("gmail", "Gmail", connector.tools())
}

/** Reads the current Gmail Connection state. */
export async function gmailStatus() {
  return getConnectorStatus("gmail")
}
