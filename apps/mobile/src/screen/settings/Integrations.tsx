import { useAtom, useAtomRefresh, useAtomValue } from '@effect/atom-react'
import {
  ConnectionState,
  ServiceCatalog,
  Workspace,
  type Connection,
  type MeResponse,
} from '@vivid/contracts'
import { LiveState, liveStateOf } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Search } from 'lucide-react-native'
import { marksOf, named } from '../../data/integration'
import { useLive, useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { Live } from '../../ui/Live'
import { Sheet } from '../../ui/Sheet'
import { Field, GUTTER, Label, Notice, Segmented, Skeleton } from '../../ui/ui'
import { Catalog } from '../integration/Catalog'
import { Connected } from '../integration/Connected'
import { useFlow, type Flow } from '../integration/flow'
import { EnterKey } from '../integration/Key'
import { Returning } from '../integration/Trip'

/**
 * The outside services Vivid can use, managed inside the phone app: what is connected, and the
 * catalog to connect more from. It is opened from Settings and from the card in a Thread; both
 * used to send the Person to the web app's settings in the browser. The only trip to the browser
 * left is the provider's own sign-in page, which cannot be shown inside this app.
 *
 * Search is on top, outside the scrolling list, and answers for both halves: it filters what is
 * connected by name and asks the server's catalog. A Person's own Integrations act only for
 * them, in every workspace; a Company's are added by an admin and can be read through by every
 * member's Vivid. What is typed into a key form goes straight to the Integration layer and is
 * never shown to Vivid, written into a Thread, or kept in this app.
 *
 * Ported from the web (`Connections` in `apps/web/src/screen/settings/Connections.tsx`): the
 * same features, states and words, as grouped lists in one full-screen sheet where the web lays
 * out grids of tiles. The web's "Text Vivid" tiles are not here; the phone has its own Texting
 * screen for that.
 */
export function Integrations({ onClose }: { onClose: () => void }) {
  const data = useLiveData()
  const me = useLive(data.live.me)
  const [query, setQuery] = useAtom(data.serviceSearch)
  return (
    <Sheet
      title="Integrations"
      presentation="fullScreen"
      content="fill"
      onClose={() => {
        // The search is the session's, so the catalog's answer can be shared and kept warm; what
        // was typed is this visit's, and the next one starts from the services most people want.
        setQuery('')
        onClose()
      }}
    >
      <Find query={query} onQuery={setQuery} />
      <ScrollView
        // The sheet keeps the screen's margin around its content; the list takes it back so it
        // scrolls under the full width of the glass and its indicator sits at the edge.
        style={{ flex: 1, marginHorizontal: -GUTTER }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: GUTTER,
          paddingTop: 8,
          paddingBottom: 32,
          gap: 24,
        }}
      >
        <Live state={me} loading={<Skeleton rows={4} />}>
          {(value) => <Body me={value} query={query} />}
        </Live>
      </ScrollView>
    </Sheet>
  )
}

/**
 * The search, first in the sheet and fixed above the list, so it is still there when the list
 * has been scrolled. A pill with a glass in it is what every search on a phone looks like.
 */
function Find({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const { colors: c } = useTheme()
  return (
    <View style={{ paddingBottom: 12 }}>
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
 * Everything under the search once the server has said who is signed in. It owns what the sheet
 * is doing (`useFlow`) and the catalog's answer, so both outlive a moment in which the list of
 * Integrations is not there to draw.
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
            flow={flow}
            onAgain={again}
          />
        )}
      </Live>
      {/* Mounted only while the Person is away at a provider's page: it is what hears them
          come back, and it draws nothing. */}
      {flow.away && <Returning onReturn={() => void flow.returned()} />}
      {Option.isSome(flow.asking) && (
        <EnterKey
          keying={flow.asking.value.keying}
          onClose={flow.closeKey}
          onConnected={flow.keyed}
        />
      )}
    </>
  )
}

/** What is connected, then the catalog, for where the Person is working. */
function Lists({
  me,
  connections,
  query,
  found,
  flow,
  onAgain,
}: {
  me: MeResponse
  connections: ReadonlyArray<Connection>
  query: string
  found: LiveState<ServiceCatalog>
  flow: Flow
  onAgain: () => void
}) {
  const [forCompany, setForCompany] = useState(false)
  const company = Workspace.guards.Company(me.workspace) ? Option.some(me.workspace) : Option.none()
  const admin = Option.exists(company, (workspace) => workspace.role !== 'member')
  const offered =
    LiveState.$is('Ready')(found) && ServiceCatalog.guards.Ready(found.value)
      ? found.value.services
      : []
  return (
    <>
      <Connected
        connections={connections.filter((item) => named(item.serviceName, query))}
        searching={query.trim().length > 0}
        company={Option.map(company, (workspace) => workspace.company.name)}
        admin={admin}
        marks={marksOf(offered)}
        flow={flow}
      />
      <Catalog
        found={found}
        searching={query.trim().length > 0}
        connected={connections
          .filter((item) => ConnectionState.guards.Ready(item.state))
          .map((item) => item.service)}
        presses={flow.presses}
        onConnect={(service) => flow.connect(service, admin && forCompany)}
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
        Who the next integration is for
      </Label>
      <Segmented
        label="Who the next integration is for"
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
