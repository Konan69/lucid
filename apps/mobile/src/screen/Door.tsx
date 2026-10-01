import { Option, Result } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { useState, type ReactNode } from 'react'
import { Linking, Platform, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ExternalLink, RotateCw } from 'lucide-react-native'
import type { FaceMood } from '@vivid/marks'
import { Pairing, spellCode, type Ending } from '../data/device'
import { attemptOf, door, useDoor } from '../data/door'
import { commit } from '../data/haptics'
import { approvalAddress, parseServer, serverName, type ServerAddress } from '../data/server'
import { adoptAtom, Outside, Session } from '../data/session'
import { emailAtom, EmailEntry, pairingAtom } from '../data/signing'
import { useTheme } from '../theme'
import { AboveKeyboard } from '../ui/Keyboard'
import {
  Button,
  Dot,
  Face,
  Field,
  GUTTER,
  HAIRLINE,
  Label,
  Labelled,
  Notice,
  Press,
  radius,
  Segmented,
} from '../ui/ui'

/**
 * The door: everything a Person sees before they are signed in.
 *
 * A phone is not served by a Vivid the way a browser is, so nothing here assumes an address. The
 * first thing asked is where the Person's Vivid is. After that the phone shows a short code and a
 * device that is already signed in lets it in; no password is typed into the phone. Each state on
 * the way (asking for a code, waiting, a server that does not answer, a code that ran out, a
 * session the server ended) has its own words, because a blank screen is how an app says nothing.
 */
export function Door({ session }: { session: Outside }) {
  return Outside.$match(session, {
    Unset: () => <Where />,
    SignedOut: ({ server }) => <SignIn server={server} ended={Option.none()} />,
    Expired: ({ server }) => (
      <SignIn
        server={server}
        ended={Option.some('You were signed out of this device. Sign in again to carry on.')}
      />
    ),
  })
}

/** The one layout every state of the door is drawn in: Vivid, a sentence, then what to do. */
function Frame({
  mood,
  title,
  lead,
  children,
}: {
  mood: FaceMood
  title: string
  lead: string
  children: ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <AboveKeyboard>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: GUTTER + 4,
          paddingTop: insets.top + 32,
          paddingBottom: insets.bottom + 32,
        }}
      >
        <View style={{ width: '100%', maxWidth: 400, alignSelf: 'center' }}>
          <Face size={52} mood={mood} />
          <Label accessibilityRole="header" size="largeTitle" style={{ marginTop: 22 }}>
            {title}
          </Label>
          <Label tone="ink-3" style={{ marginTop: 6 }}>
            {lead}
          </Label>
          <View style={{ marginTop: 28, gap: 14 }}>{children}</View>
        </View>
      </ScrollView>
    </AboveKeyboard>
  )
}

/**
 * Asks where the Person's Vivid is. The address is read strictly (`parseServer`): a session token
 * is later sent to whatever is accepted here, so a typo is refused with a sentence rather than
 * guessed at.
 */
function Where() {
  const [text, setText] = useState('')
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const saving = attemptOf(useDoor(adoptAtom))

  function proceed() {
    const parsed = parseServer(text)
    if (Result.isFailure(parsed)) {
      setRefused(Option.some(parsed.failure.message))
      return
    }
    setRefused(Option.none())
    door.set(adoptAtom, Session.SignedOut({ server: parsed.success }))
  }

  const refusal = Option.orElse(refused, () => saving.refusal)
  return (
    <Frame
      mood="happy"
      title="Where is your Vivid?"
      lead="Vivid runs on a server you choose, often your own computer. Enter its address and this phone will stay connected to it."
    >
      <Labelled label="Server address">
        <Field
          accessibilityLabel="Server address"
          value={text}
          placeholder="http://192.168.1.20:5178"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          returnKeyType="go"
          onChangeText={(next) => {
            setText(next)
            setRefused(Option.none())
          }}
          onSubmitEditing={proceed}
        />
      </Labelled>
      {Option.isSome(refusal) && <Notice message={refusal.value} />}
      <Button
        kind="primary"
        label="Continue"
        disabled={saving.busy || text.trim().length === 0}
        onPress={proceed}
      />
    </Frame>
  )
}

/** The two ways in. A code is first because it is the one that needs nothing typed but itself. */
const WAYS = [
  { value: 'code', label: 'With a code' },
  { value: 'email', label: 'With a password' },
] as const
type Way = (typeof WAYS)[number]['value']

/** Signing in to a chosen server, by code or by email, with the server always one tap from changing. */
function SignIn({ server, ended }: { server: ServerAddress; ended: Option.Option<string> }) {
  const [way, setWay] = useState<Way>('code')
  return (
    <Frame
      mood="neutral"
      title="Sign in to Vivid"
      lead="This phone signs in as you and stays connected, so your threads are live here too."
    >
      {Option.isSome(ended) && <Notice message={ended.value} />}
      <ServerLine server={server} />
      <Segmented label="How to sign in" value={way} options={WAYS} onChange={setWay} />
      {way === 'code' ? <Code server={server} /> : <Email server={server} />}
    </Frame>
  )
}

/** Which server this is about, and the way to choose another. */
function ServerLine({ server }: { server: ServerAddress }) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={`Server ${serverName(server)}. Change server`}
      onPress={() => door.set(adoptAtom, Session.Unset())}
      style={({ pressed }) => ({
        minHeight: 52,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderRadius: radius.control,
        borderWidth: HAIRLINE,
        borderColor: c['line-2'],
        backgroundColor: pressed ? c['wash-pressed'] : c['surface-2'],
      })}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size="caption" tone="ink-3">
          Server
        </Label>
        <Label numberOfLines={1} size="footnote">
          {serverName(server)}
        </Label>
      </View>
      <Label size="label" tone="accent-ink">
        Change
      </Label>
    </Press>
  )
}

/** What each way an exchange can end means to the Person, and what they can do about it. */
const ENDINGS = {
  unreachable: {
    title: 'Vivid could not be reached',
    detail:
      'Nothing answered at that address. Check that Vivid is running there and that this phone is on the same network.',
    again: 'Try again',
  },
  expired: {
    title: 'That code ran out',
    detail: 'A code is good for a few minutes. Ask for a new one when you are ready to enter it.',
    again: 'Get a new code',
  },
  denied: {
    title: 'That sign-in was turned down',
    detail: 'Someone chose not to let this phone in. Ask for a new code to try again.',
    again: 'Get a new code',
  },
  refused: {
    title: 'This server would not start a sign-in',
    detail: 'It answered, but not with a code. It may not be a Vivid, or it may be an older one.',
    again: 'Try again',
  },
} as const satisfies Record<Ending, { title: string; detail: string; again: string }>

/**
 * Signing in with a code. Reading the exchange is what runs it (`pairingAtom`): it starts when
 * this is drawn, stops mid-wait when it is not, and asking again is a refresh of the same atom.
 * When the code is entered elsewhere the exchange adopts the session itself and this whole
 * screen is replaced, so there is nothing to do here on success.
 */
function Code({ server }: { server: ServerAddress }) {
  const exchange = pairingAtom(server)
  const state = AsyncResult.getOrElse(useDoor(exchange), () => Pairing.Asking())
  const again = () => door.refresh(exchange)
  return Pairing.$match(state, {
    Asking: () => <CodePanel code={Option.none()} status="Asking Vivid for a code…" />,
    Waiting: ({ userCode }) => (
      <>
        <CodePanel code={Option.some(spellCode(userCode))} status="Waiting for you to enter it…" />
        <Label size="label" tone="ink-3">
          On a device where you are already signed in, open Settings, then Devices, and enter this
          code.
        </Label>
        <Button
          icon={ExternalLink}
          label="Open the approval page"
          onPress={() => void Linking.openURL(approvalAddress(server, userCode))}
        />
      </>
    ),
    Approved: () => <CodePanel code={Option.none()} status="Signed in. Opening your threads…" />,
    Ended: ({ why }) => (
      <>
        <View style={{ gap: 4 }}>
          <Label size="footnote">{ENDINGS[why].title}</Label>
          <Label size="label" tone="ink-3">
            {ENDINGS[why].detail}
          </Label>
        </View>
        <Button
          kind="primary"
          icon={RotateCw}
          label={ENDINGS[why].again}
          onPress={() => {
            commit()
            again()
          }}
        />
      </>
    ),
  })
}

/** The code in large type, or the outline of one, the same size, while it has not arrived. */
function Spelled({ code }: { code: Option.Option<string> }) {
  const { colors: c } = useTheme()
  if (Option.isNone(code)) {
    return (
      <View
        style={{ height: 35, width: 190, borderRadius: 8, backgroundColor: c['wash-pressed'] }}
      />
    )
  }
  return (
    <Label
      selectable
      size="display"
      accessibilityLabel={`Code ${code.value.split('').join(' ')}`}
      style={{
        // Every character the same width, so the two halves line up and read as a code.
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        letterSpacing: 3,
      }}
    >
      {code.value}
    </Label>
  )
}

/**
 * The code itself, large enough to read across a desk, with what is happening under it. While
 * there is no code yet the panel keeps its size and shows the outline of one, so nothing jumps
 * when the code arrives.
 */
function CodePanel({ code, status }: { code: Option.Option<string>; status: string }) {
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        alignItems: 'center',
        paddingVertical: 22,
        gap: 12,
        borderRadius: radius.card,
        borderWidth: HAIRLINE,
        borderColor: c['line-2'],
        backgroundColor: c['surface-2'],
      }}
    >
      <Spelled code={code} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Dot tone="status-working" />
        <Label size="label" tone="ink-3">
          {status}
        </Label>
      </View>
    </View>
  )
}

/** Whether the email form is making an account or entering one. */
const ACCOUNTS = [
  { value: 'enter', label: 'I have an account' },
  { value: 'create', label: 'I am new' },
] as const
type Account = (typeof ACCOUNTS)[number]['value']

/**
 * Signing in with an email and password, for a Person with no other device to enter a code on.
 * The password is handed to the server once and is not kept; what the phone keeps is the session
 * the server answers with.
 */
function Email({ server }: { server: ServerAddress }) {
  const [account, setAccount] = useState<Account>('enter')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const attempt = attemptOf(useDoor(emailAtom))
  const creating = account === 'create'
  const named = !creating || name.trim().length > 0
  const complete = email.includes('@') && password.length >= 8 && named
  const action = creating ? 'Create account' : 'Sign in'

  function submit() {
    if (!complete || attempt.busy) return
    const entry = { server, email: email.trim(), password }
    door.set(
      emailAtom,
      creating ? EmailEntry.Create({ ...entry, name: name.trim() }) : EmailEntry.Enter(entry),
    )
  }

  return (
    <>
      <Segmented label="Account" value={account} options={ACCOUNTS} onChange={setAccount} />
      {creating && (
        <Labelled label="Your name">
          <Field
            accessibilityLabel="Your name"
            value={name}
            autoComplete="name"
            textContentType="name"
            onChangeText={setName}
          />
        </Labelled>
      )}
      <Labelled label="Email">
        <Field
          accessibilityLabel="Email"
          value={email}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          onChangeText={setEmail}
        />
      </Labelled>
      <Labelled label={creating ? 'Password, at least 8 characters' : 'Password'}>
        <Field
          accessibilityLabel="Password"
          value={password}
          secureTextEntry
          autoCapitalize="none"
          textContentType={creating ? 'newPassword' : 'password'}
          returnKeyType="go"
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />
      </Labelled>
      {Option.isSome(attempt.refusal) && <Notice message={attempt.refusal.value} />}
      <Button
        kind="primary"
        label={attempt.busy ? 'One moment…' : action}
        disabled={!complete || attempt.busy}
        onPress={submit}
      />
    </>
  )
}
