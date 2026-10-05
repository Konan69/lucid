import { RuleScope, Workspace, type Rule, type RuleDecision } from '@vivid/contracts'
import { Data, Option, Result } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import { Trash2 } from 'lucide-react-native'
import { commit, warn } from '../../data/haptics'
import { useLive, useLiveData } from '../../data/live'
import { Row, Section } from '../../ui/List'
import { Live } from '../../ui/Live'
import { Sheet } from '../../ui/Sheet'
import {
  Button,
  confirmDestructive,
  Field,
  IconButton,
  Notice,
  Segmented,
  Skeleton,
} from '../../ui/ui'
import { useMe } from '../../workspace'

/** The three things a rule can decide, in the words the choice is offered in. */
const DECISIONS = [
  { value: 'Allow', label: 'Allow' },
  { value: 'Ask', label: 'Ask me' },
  { value: 'Never', label: 'Never' },
] as const satisfies ReadonlyArray<{ value: RuleDecision; label: string }>

/** What a rule's decision means, as the sentence under the rule. */
const SAYS = {
  Allow: 'Vivid does this without asking.',
  Ask: 'Vivid asks first, every time.',
  Never: 'Vivid never does this.',
} satisfies Record<RuleDecision, string>

/** Whose a rule is, as the word the form keeps while it is being written. */
type Whose = RuleScope['_tag']

/**
 * The scope sent for each choice, and the example the field shows for it. Keyed by the contract's
 * own cases, so a new kind of scope does not compile until it has both.
 */
const WHOSE = {
  Personal: {
    scope: RuleScope.cases.Personal.make({}),
    placeholder: 'e.g. Send email to people outside my company',
  },
  Company: {
    scope: RuleScope.cases.Company.make({}),
    placeholder: 'e.g. Delete anything in a shared drive',
  },
} satisfies Record<Whose, { scope: RuleScope; placeholder: string }>

/** The choice an owner or admin is given between the two, in the form. */
const FOR = [
  { value: 'Personal', label: 'For you' },
  { value: 'Company', label: 'For everyone' },
] as const satisfies ReadonlyArray<{ value: Whose; label: string }>

/**
 * The Company the Person is working in, as far as rules care: what it is called, and whether this
 * Person may write and remove its rules (an owner or admin may; a member reads them).
 */
type Shared = { readonly name: string; readonly manages: boolean }

/** The Company a workspace is, or none in a Person's own space, where only their rules exist. */
const sharedOf = (workspace: Workspace): Option.Option<Shared> =>
  Workspace.match(workspace, {
    Personal: () => Option.none<Shared>(),
    Company: ({ company, role }) =>
      Option.some<Shared>({ name: company.name, manages: role !== 'member' }),
  })

/**
 * What Vivid may do without asking, as a sheet over Settings. A rule is a sentence and a decision.
 * A Person's own rules follow them everywhere; a Company's rules bind every member, and nobody's
 * own rule can loosen one: never beats ask, and ask beats allow, whoever wrote them. With no rule,
 * Vivid asks before anything that changes something outside itself.
 *
 * The same live list, words and behaviour as the web's Rules
 * (`apps/web/src/screen/settings/Rules.tsx`), which the phone used to open in the browser. What
 * differs is the layout: the web puts a form under each list; a phone has one keyboard and one
 * thumb, so there is one form, in the sheet's footer above the keyboard, and an owner or admin
 * chooses there whom the rule is for. Removing asks first, because on a phone the control is one
 * touch away from a scroll.
 */
export function Rules({ onClose }: { onClose: () => void }) {
  const me = useMe()
  const data = useLiveData()
  const rules = useLive(data.live.rules)
  const shared = sharedOf(me.workspace)
  const [unremoved, setUnremoved] = useState<Option.Option<string>>(Option.none())

  /**
   * Removes a rule. It leaves the list at once and comes back if the server refuses, with the
   * sentence that says so above the list.
   */
  async function remove(rule: Rule) {
    warn()
    setUnremoved(Option.none())
    const result = await data.change(
      (client) => client.DeleteRule({ id: rule.id }),
      () =>
        data.live.rules.expect((current) => ({
          ...current,
          rules: current.rules.filter((kept) => kept.id !== rule.id),
        })),
    )
    if (Result.isFailure(result)) {
      setUnremoved(Option.some('That rule could not be removed. Try again.'))
    }
  }

  const askToRemove = (rule: Rule) =>
    confirmDestructive({
      title: 'Remove this rule?',
      detail: `Vivid stops following “${rule.action}”.`,
      action: 'Remove rule',
      onConfirm: () => void remove(rule),
    })

  return (
    <Sheet
      title="Rules"
      onClose={onClose}
      footer={<NewRule manages={Option.exists(shared, (company) => company.manages)} />}
    >
      {Option.isSome(unremoved) && <Notice message={unremoved.value} />}
      <Live state={rules} loading={<Skeleton rows={3} />}>
        {(value) => <Listed rules={value.rules} shared={shared} onRemove={askToRemove} />}
      </Live>
    </Sheet>
  )
}

/**
 * The Person's own rules, then their Company's when they are working in one. Each list says in a
 * sentence what it is and, when it has nothing in it, what Vivid does in the meantime.
 */
function Listed({
  rules,
  shared,
  onRemove,
}: {
  rules: ReadonlyArray<Rule>
  shared: Option.Option<Shared>
  onRemove: (rule: Rule) => void
}) {
  const mine = rules.filter((rule) => RuleScope.guards.Personal(rule.scope))
  const companys = rules.filter((rule) => RuleScope.guards.Company(rule.scope))
  return (
    <>
      <Section
        title="Your rules"
        detail="They apply to Vivid when it acts for you, in every workspace."
      >
        {mine.length === 0 && (
          <Row wrap title="No rules yet. Vivid asks before it changes anything outside itself." />
        )}
        {mine.map((rule) => (
          <RuleRow key={rule.id} rule={rule} removal={Option.some(onRemove)} />
        ))}
      </Section>
      {Option.isSome(shared) && (
        <Section
          title={`${shared.value.name}’s rules`}
          detail="They bind everyone. A personal rule can make Vivid stricter, never looser."
        >
          {companys.length === 0 && <Row title="No company rules yet." />}
          {companys.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              // Only an owner or admin removes a rule that binds everyone.
              removal={shared.value.manages ? Option.some(onRemove) : Option.none()}
            />
          ))}
        </Section>
      )}
    </>
  )
}

/**
 * One rule: its sentence read whole, what it decides and who set it, and the way to remove it for
 * whoever may. The row itself is not a button; a rule has nowhere to go.
 */
function RuleRow({
  rule,
  removal,
}: {
  rule: Rule
  /** How this Person removes the rule, or none when it is not theirs to remove. */
  removal: Option.Option<(rule: Rule) => void>
}) {
  return (
    <Row
      wrap
      title={rule.action}
      detail={`${SAYS[rule.decision]} Set by ${rule.createdBy.name}.`}
      trailing={
        Option.isSome(removal) ? (
          <IconButton
            icon={Trash2}
            label={`Remove the rule “${rule.action}”`}
            onPress={() => removal.value(rule)}
          />
        ) : undefined
      }
    />
  )
}

/** How the last attempt to add a rule went. */
type Adding = Data.TaggedEnum<{ Idle: {}; Asking: {}; Refused: {} }>
const Adding = Data.taggedEnum<Adding>()

/**
 * The form a new rule is written in: what the action is, in the Person's own words, and what
 * Vivid should do about it. It starts on "Ask me", the careful answer and the one that changes
 * least if it is added by mistake.
 *
 * An owner or admin also says whom it is for; anyone else writes only their own, so the choice is
 * not drawn. The field is cleared only once the rule is saved: a refused rule is still in the
 * field to send again, with the sentence that says so above it.
 */
function NewRule({ manages }: { manages: boolean }) {
  const data = useLiveData()
  const [action, setAction] = useState('')
  const [decision, setDecision] = useState<RuleDecision>('Ask')
  const [chosen, setChosen] = useState<Whose>('Personal')
  const [adding, setAdding] = useState<Adding>(Adding.Idle())
  // Who may write a Company's rules is read live: someone who stops being an admin with the
  // sheet open writes their own rule, whatever the form last had chosen.
  const whose = manages ? chosen : 'Personal'
  const text = action.trim()
  const asking = Adding.$is('Asking')(adding)

  async function add() {
    if (text.length === 0 || asking) return
    setAdding(Adding.Asking())
    const result = await data.change((client) =>
      client.CreateRule({ action: text, decision, scope: WHOSE[whose].scope }),
    )
    if (Result.isFailure(result)) {
      setAdding(Adding.Refused())
      return
    }
    commit()
    setAction('')
    setAdding(Adding.Idle())
  }

  return (
    <View style={{ gap: 10 }}>
      {Adding.$is('Refused')(adding) && <Notice message="That rule could not be saved." />}
      <Field
        accessibilityLabel="New rule"
        value={action}
        placeholder={WHOSE[whose].placeholder}
        maxLength={200}
        returnKeyType="done"
        onChangeText={(next) => {
          setAction(next)
          // The refusal was about the words as they were; new words are a new attempt.
          if (Adding.$is('Refused')(adding)) setAdding(Adding.Idle())
        }}
        onSubmitEditing={() => void add()}
      />
      {manages && (
        <Segmented label="Who it is for" value={whose} options={FOR} onChange={setChosen} />
      )}
      <Segmented label="Decision" value={decision} options={DECISIONS} onChange={setDecision} />
      <Button
        kind="primary"
        label={asking ? 'Adding…' : 'Add rule'}
        disabled={asking || text.length === 0}
        onPress={() => void add()}
      />
    </View>
  )
}
