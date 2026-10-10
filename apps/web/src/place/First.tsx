import { useMe } from '../data/me'
import { First } from '../screen/First'

/** What `/` draws. */
export function FirstPlace() {
  return <First me={useMe()} />
}
