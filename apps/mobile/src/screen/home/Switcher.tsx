import { SwitchWorkspaceRequest, Workspace, type MeResponse } from '@vivid/contracts'
import { Effect, Option, Result } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import { Building2, Check, Plus } from 'lucide-react-native'
import { confirm, tick } from '../../data/haptics'
import { useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { Avatar, pictureOf } from '../../ui/Avatar'
import { Row, Section } from '../../ui/List'
import { NameSheet, Sheet } from '../../ui/Sheet'
import { Notice } from '../../ui/ui'
import { ROLE_NAME } from '../../workspace'
import { start } from '../../data/app'

/** The mark beside the workspace the session is working in. */
function Here({ active }: { active: boolean }) {
  const { colors: c } = useTheme()
  // An empty box keeps every row's text ending at the same edge whether or not it is marked.
  return (
    <View style={{ width: 20, alignItems: 'center' }}>
      {active && <Check accessibilityLabel="Current" size={18} strokeWidth={2} color={c.accent} />}
    </View>
  )
}

/**
 * Where the Person is working, and the way to somewhere else. Their own space is always first.
 * A Company appears only because they made one or were invited to one. The last entry is the
 * one place in the app a Company is created: it says in a line what a Company gives, and then
 * asks for nothing but a name.
 *
 * Switching is one call. Every list on every screen is a live query scoped by the server to the
 * workspace the session is in, so nothing here has to tell them to change.
 */
export function Switcher({ me, onClose }: { me: MeResponse; onClose: () => void }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const [creating, setCreating] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const activeCompany = Workspace.guards.Company(me.workspace) ? me.workspace.company.id : null

  function enter(to: SwitchWorkspaceRequest) {
    return start(
      Effect.gen(function* () {
        tick()
        const result = yield* data.changing((client) => client.SwitchWorkspace({ to }))
        if (Result.isFailure(result)) setRefused(Option.some(result.failure.message))
        else onClose()
      }),
    )
  }

  if (creating) {
    return (
      <NameSheet
        title="Create a company"
        detail="Shared threads, a shared Library and shared rules for the people you work with. Your own threads, notes and integrations stay yours."
        label="Company name"
        initial=""
        placeholder="Acme"
        action="Create company"
        maxLength={80}
        onClose={onClose}
        onSave={(name) =>
          Effect.gen(function* () {
            const result = yield* data.changing((client) => client.CreateCompany({ name }))
            if (Result.isFailure(result)) {
              return Option.some('The company could not be created. Try again.')
            }
            confirm()
            return Option.none()
          })
        }
      />
    )
  }

  return (
    <Sheet title="Where you are working" onClose={onClose}>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Section title="Your space">
        <Row
          leading={<Avatar name={me.person.name} image={pictureOf(me.person)} size={28} />}
          title={me.person.name}
          detail="Only you"
          trailing={<Here active={activeCompany === null} />}
          onPress={() => void enter(SwitchWorkspaceRequest.cases.Personal.make({}))}
        />
      </Section>
      {me.companies.length > 0 && (
        <Section title="Companies">
          {me.companies.map((membership) => (
            <Row
              key={membership.company.id}
              leading={<Building2 size={22} strokeWidth={1.6} color={c['ink-2']} />}
              title={membership.company.name}
              detail={ROLE_NAME[membership.role]}
              trailing={<Here active={membership.company.id === activeCompany} />}
              onPress={() =>
                void enter(
                  SwitchWorkspaceRequest.cases.Company.make({ companyId: membership.company.id }),
                )
              }
            />
          ))}
        </Section>
      )}
      <Section title="Something new">
        <Row
          leading={<Plus size={22} strokeWidth={1.6} color={c['ink-2']} />}
          title="Create a company"
          detail="Shared threads, a shared Library and shared rules."
          onPress={() => setCreating(true)}
        />
      </Section>
    </Sheet>
  )
}
