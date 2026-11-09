import { useAtom, useAtomRefresh, useAtomValue } from '@effect/atom-react'
import {
  ConnectionState,
  ServiceCatalog,
  Workspace,
  type Connection,
  type MeResponse,
  type Service,
} from '@vivid/contracts'
import { asksName, LiveState, liveStateOf } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Search } from 'lucide-react-native'
import { marksOf, named } from '../../data/integration'
import { useLive, useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { Live } from '../../ui/Live'
import { Screen } from '../../ui/Screen'
import { Card, Field, Label, Notice, Segmented, Skeleton, styles } from '../../ui/ui'
import { useGo, useMe } from '../../workspace'
import { Catalog } from '../integration/Catalog'
import { Connected } from '../integration/Connected'
import { KeyForm } from '../integration/Key'
import { useFlow } from '../integration/flow'

/**
 * The outside services Vivid can use, managed inside the phone app: what is connected, and the
 * catalog to connect more from. It is a screen on the stack, reached from Settings, under the
 * system's bar. The only trip to the browser is the provider's own sign-in page, which cannot be
 * shown inside this app.
 *
 * It was a full-screen sheet (a React Native `Modal`) over Settings and over a Thread. It is a
 * route now because an account's own sheet and the form that names a new one are the platform's
 * bottom sheets, presented from here, and the platform cannot present one over a `Modal`. A
 * Thread's card no longer opens this page at all: it connects in place (`Card.tsx`).
 *
 * Search is first on the page and answers for both halves: it filters what is connected by name
 * and asks the server's catalog. A Person's own Integrations act only for them, in every
 * workspace; a Company's are added by an admin and can be read through by every member's Vivid.
 * What is typed into a key form goes straight to the Integration layer and is never shown to
 * Vivid, written into a Thread, or kept in this app.
 *
 * What is typed in the search is the session's, so the catalog's answer can be shared and kept
 * warm; it is cleared, with what earlier presses left said, by the row that opens this page
 * (`Settings`), so no effect is needed to start each visit afresh.
 *
 * Ported from the web (`Connections` in `apps/web/src/screen/settings/Connections.tsx`): the
 * same features, states and words, as grouped lists where the web lays out grids of tiles. The
 * web's "Text Vivid" tiles are not here; the phone has its own Texting screen for that.
 */
export function Integrations() {
  const data = useLiveData()
  const me = useMe()
  const [query, setQuery] = useAtom(data.serviceSearch)
  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.page, styles.column]}
      >
        <Find query={query} onQuery={setQuery} />
        <Body me={me} query={query} />
      </ScrollView>
    </Screen>
  )
}

/**
 * The search, first on the page. It scrolls with the lists: fixed above them it would sit behind
 * the system's glass bar, which only a scroller is laid out clear of. A pill with a glass in it
 * is what every search on a phone looks like.
 */
function Find({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const { colors: c } = useTheme()
  return (
    <View>
      <Field
        value={query}
        onChangeText={onQuery}
        // The catalog search takes at most this many characters; the field stops there too, so
        // a longer name is never a request the server refuses.
        maxLength={80}
        accessibilityLabel="Search integrations"
        // How many the catalog holds is never said: a number that size is noise to a Person.
        placeholder="Search integrations"
        inputMode="search"
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        clearButtonMode="while-editing"
        style={{ paddingStart: 46, borderRadius: 26 }}
      />
      {/* Laid over the field's leading edge, at the field's own height, and never in the way of
          a finger: the field underneath takes the touch. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', start: 16, top: 0, height: 52, justifyContent: 'center' }}
      >
        <Search size={18} strokeWidth={1.7} color={c['ink-3']} />
      </View>
    </View>
  )
}

/**
 * Everything under the search. It reads the list of Integrations and the catalog's answer, and
 * acts through the shell's one flow (`useFlow`), which presses and reads the session's connecting
 * machine; the machine opens the key form and hears the Person come back from a provider's page.
 */
function Body({ me, query }: { me: MeResponse; query: string }) {
  const data = useLiveData()
  const connections = useLive(data.live.connections)
  const found = liveStateOf(useAtomValue(data.services))
  const again = useAtomRefresh(data.services)
  const flow = useFlow()
  return (
    <>
      {/* Something that did not happen is said where the Person is looking: above the lists. */}
      {Option.isSome(flow.refused) && <Notice message={flow.refused.value} />}
      <Live state={connections} loading={<Skeleton rows={4} />}>
        {(value) => (
          <Lists
            me={me}
            connections={value.connections}
            query={query}
            found={found}
            onAgain={again}
          />
        )}
      </Live>
    </>
  )
}

/** What is connected, then the catalog, for where the Person is working. */
function Lists({
  me,
  connections,
  query,
  found,
  onAgain,
}: {
  me: MeResponse
  connections: ReadonlyArray<Connection>
  query: string
  found: LiveState<ServiceCatalog>
  onAgain: () => void
}) {
  const flow = useFlow()
  const go = useGo()
  const [forCompany, setForCompany] = useState(false)
  const company = Workspace.guards.Company(me.workspace) ? Option.some(me.workspace) : Option.none()
  const admin = Option.exists(company, (workspace) => workspace.role !== 'member')
  const offered =
    LiveState.$is('Ready')(found) && ServiceCatalog.guards.Ready(found.value)
      ? found.value.services
      : []

  /**
   * Adds an account on a service, for this Person or their Company: the first, or one more on a
   * service that is already connected. `accounts` are the ones the Person has there now. Where
   * none of them says who it is, the new one is asked a name first, in its own bottom sheet,
   * which begins it; otherwise it is begun at once.
   */
  const connect = (service: Service, accounts: ReadonlyArray<Connection>) => {
    const shared = admin && forCompany
    if (asksName(accounts)) {
      go.navigate('NameAccount', {
        service: service.id,
        serviceName: service.name,
        shared,
        card: null,
      })
      return
    }
    flow.add(service.id, shared, Option.none(), Option.none())
  }

  const keying = flow.keying(Option.none())
  return (
    <>
      {/* A key wanted for an account the live list has not shown yet: its own card until the
          account's row arrives and the form moves under it. */}
      {Option.isSome(keying) && connections.every((item) => item.id !== keying.value.id) && (
        <Card style={{ gap: 12 }}>
          <Label accessibilityRole="header" size="footnote">
            Connect {keying.value.serviceName}
          </Label>
          <KeyForm keying={keying.value} />
        </Card>
      )}
      <Connected
        connections={connections.filter((item) => named(item.serviceName, query))}
        searching={query.trim().length > 0}
        company={Option.map(company, (workspace) => workspace.company.name)}
        admin={admin}
        marks={marksOf(offered)}
        standing={flow.standing}
        busy={flow.busy}
        keying={keying}
        onResume={(connection) => flow.resume(connection.id, Option.none())}
        onManage={(connection) => go.navigate('Account', { id: connection.id })}
      />
      <Catalog
        found={found}
        searching={query.trim().length > 0}
        ready={connections.filter((item) => ConnectionState.guards.Ready(item.state))}
        standing={flow.standing}
        busy={flow.busy}
        onConnect={connect}
        onAgain={onAgain}
        whose={
          admin && Option.isSome(company) ? (
            <Whose
              company={company.value.company.name}
              forCompany={forCompany}
              onChange={setForCompany}
            />
          ) : null
        }
      />
    </>
  )
}

/**
 * An admin's choice of who the next Integration is for: themselves, or everyone at the Company.
 * It sits over the catalog, which is what it changes, and says what it is in words: a phone has
 * no hover to explain two bare segments.
 */
function Whose({
  company,
  forCompany,
  onChange,
}: {
  company: string
  forCompany: boolean
  onChange: (forCompany: boolean) => void
}) {
  return (
    <View style={{ gap: 8 }}>
      {/* The control below says the same words to a screen reader, so they are read once. */}
      <Label
        accessibilityElementsHidden
        importantForAccessibility="no"
        size="label"
        tone="ink-2"
        style={{ paddingHorizontal: 4 }}
      >
        Who new integrations are for
      </Label>
      <Segmented
        label="Who new integrations are for"
        value={forCompany ? 'company' : 'you'}
        onChange={(value) => onChange(value === 'company')}
        options={[
          { value: 'you', label: 'For you' },
          { value: 'company', label: `For ${company}` },
        ]}
      />
    </View>
  )
}
