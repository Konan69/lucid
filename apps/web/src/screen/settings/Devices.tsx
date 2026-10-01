import { Result } from 'effect'
import { useState } from 'react'
import { approveDevice } from '../../data/account'
import { run } from '../../data/app'
import { Button } from '../../ui/Button'
import { Row, Section } from './Parts'

/**
 * Signing in a phone or the desktop app. The other device shows a short code; typing it here lets
 * that device act as this Person, on this server, without their password ever leaving this
 * browser. Nothing is paired until the code is entered by someone who is already signed in.
 */
export function Devices({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode)
  const [outcome, setOutcome] = useState<'idle' | 'paired' | 'refused'>('idle')

  async function pair() {
    const result = await run(approveDevice(code.trim().toUpperCase()))
    setOutcome(Result.isSuccess(result) ? 'paired' : 'refused')
    if (Result.isSuccess(result)) setCode('')
  }

  return (
    <Section
      title="Sign in another device"
      detail="Open Vivid on your phone or the desktop app and choose “Sign in with a code”."
    >
      <Row label="Code from the other device" detail="It looks like ABCD-EFGH.">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void pair()
          }}
        >
          <input
            value={code}
            onChange={(event) => {
              setCode(event.currentTarget.value)
              setOutcome('idle')
            }}
            placeholder="ABCD-EFGH"
            autoCapitalize="characters"
            spellCheck={false}
            className="h-8 w-36 rounded-control bg-well px-3 font-mono text-label text-ink uppercase ring-line outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" variant="primary" size="sm" disabled={code.trim().length < 4}>
            Sign it in
          </Button>
        </form>
      </Row>
      {outcome === 'paired' && (
        <p className="px-4 py-3 text-label text-success">Done. That device is signed in as you.</p>
      )}
      {outcome === 'refused' && (
        <p role="alert" className="px-4 py-3 text-label text-danger">
          That code is not waiting, or it ran out. Ask the device for a new one.
        </p>
      )}
    </Section>
  )
}
