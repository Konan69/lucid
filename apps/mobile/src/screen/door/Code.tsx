import { Pairing, spellCode, type Ending } from '@vivid/state'
import { Option } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { Linking, View } from 'react-native'
import { door, useDoor } from '../../data/door'
import { commit } from '../../data/haptics'
import { approvalAddress } from '../../data/server'
import { pairingAtom } from '../../data/signing'
import { useTheme } from '../../theme'
import { Button, Label, MONO } from '../../ui/ui'
import { Quiet, Step, useServer } from './Frame'

/** What each way an exchange can end means to the Person, and what they can do about it. */
const ENDINGS = {
  unreachable: {
    title: 'Can’t reach Vivid',
    detail: 'Check your connection and try again.',
    again: 'Try again',
  },
  expired: {
    title: 'This code ran out',
    detail: 'A code lasts a few minutes. Get a new one when you are ready to enter it.',
    again: 'Get a new code',
  },
  denied: {
    title: 'This phone was not let in',
    detail: 'Someone chose not to approve it. Get a new code to try again.',
    again: 'Get a new code',
  },
  refused: {
    title: 'Vivid could not start a sign-in',
    detail: 'Try again in a moment.',
    again: 'Try again',
  },
} as const satisfies Record<Ending, { title: string; detail: string; again: string }>

/** The code in large type, or the outline of one, the same size, while it has not arrived. */
export function Spelled({ code }: { code: Option.Option<string> }) {
  const { colors: c } = useTheme()
  if (Option.isNone(code)) {
    return (
      <View
        accessibilityLabel="Getting a code"
        style={{ height: 36, width: 200, borderRadius: 8, backgroundColor: c.subtle }}
      />
    )
  }
  return (
    <Label
      selectable
      size="display"
      accessibilityLabel={`Code ${code.value.split('').join(' ')}`}
      // Every character the same width, so the two halves line up and read as a code.
      style={{ fontFamily: MONO, letterSpacing: 3 }}
    >
      {code.value}
    </Label>
  )
}

/**
 * Signing in with a code, for a Person who is already signed in somewhere else and has no
 * password to type. Reading the exchange is what runs it (`pairingAtom`): it starts when this
 * step is drawn, stops mid-wait when it is left, and asking again is a refresh of the same atom.
 * When the code is entered elsewhere the exchange adopts the session itself and the whole door
 * is replaced, so there is nothing to do here on success.
 *
 * The code sits directly on the page in large type. It has no box: it is the only thing on the
 * step, and the step's own sentence says what to do with it.
 */
export function Code() {
  const server = useServer()
  const exchange = pairingAtom(server)
  const state = AsyncResult.getOrElse(useDoor(exchange), () => Pairing.Asking())
  const again = () => {
    commit()
    door.refresh(exchange)
  }
  return Pairing.$match(state, {
    Asking: () => (
      <Step title="Sign in with a code" lead="Getting a code…" foot={null}>
        <Spelled code={Option.none()} />
      </Step>
    ),
    Waiting: ({ userCode }) => (
      <Step
        title="Sign in with a code"
        lead="On a device where you are already signed in, open Settings, then Devices, and enter this code."
        foot={
          <Quiet
            label="Open the approval page"
            onPress={() => void Linking.openURL(approvalAddress(server, userCode))}
          />
        }
      >
        <Spelled code={Option.some(spellCode(userCode))} />
        <Label accessibilityLiveRegion="polite" size="label" tone="ink-2">
          Waiting for you to enter it there.
        </Label>
      </Step>
    ),
    Approved: () => (
      <Step title="You are in" lead="Opening Vivid…" foot={null}>
        {null}
      </Step>
    ),
    Ended: ({ why }) => (
      <Step
        title={ENDINGS[why].title}
        lead={ENDINGS[why].detail}
        foot={<Button kind="primary" label={ENDINGS[why].again} onPress={again} />}
      >
        {null}
      </Step>
    ),
  })
}
