import { Effect, Result, Schema } from 'effect'
import { useState } from 'react'
import { Share as SystemShare } from 'react-native'
import { Share2 } from 'lucide-react-native'
import { useLiveData } from '../data/live'
import { Button, Notice } from './ui'

/** A platform share refusal leaves the draft readable and copyable instead of claiming it went out. */
class ShareRefused extends Schema.TaggedError<ShareRefused>()(
  'ShareRefused',
  {},
  { title: 'Sharing refused' },
) {}

/** Native cancellation is a resolved Share result, so only a rejected platform call is a refusal. */
const share = Effect.fn('Draft.share')(function* (content: { title: string; message: string }) {
  yield* Effect.tryPromise({
    try: () => SystemShare.share(content),
    catch: () => new ShareRefused({}),
  })
})

/** The system chooses a destination; this control never sends the draft through Vivid itself. */
export function Share({ title, read }: { title: string; read: () => string }) {
  const data = useLiveData()
  const [refused, setRefused] = useState(false)
  return (
    <>
      <Button
        label="Share"
        icon={Share2}
        onPress={() => {
          setRefused(false)
          void data
            .run(share({ title, message: read() }))
            .then((result) => setRefused(Result.isFailure(result)))
        }}
      />
      {refused && <Notice message="It could not be shared. Try again." />}
    </>
  )
}
