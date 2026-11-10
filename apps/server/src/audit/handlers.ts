import { live } from '../live/query.ts'
import { loadAudit } from './store.ts'

export const auditHandlers = {
  WatchAudit: () => live('WatchAudit', [], loadAudit),
}
