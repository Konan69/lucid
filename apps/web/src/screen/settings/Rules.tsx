import {
  RuleScope,
  Workspace,
  type MeResponse,
  type Rule,
  type RuleDecision,
} from '@vivid/contracts'
import { Result } from 'effect'
import { useState } from 'react'
import { change, live, LiveState, useLive } from '../../data/live'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { Awaiting, Empty, Refusal, Section } from './Parts'

const DECISIONS = [
  { value: 'Allow', label: 'Allow', name: 'Allow without asking' },
  { value: 'Ask', label: 'Ask me', name: 'Always ask first' },
  { value: 'Never', label: 'Never', name: 'Never do this' },
] as const satisfies ReadonlyArray<{ value: RuleDecision; label: string; name: string }>

const SAYS = {
  Allow: 'Vivid does this without asking.',
  Ask: 'Vivid asks first, every time.',
  Never: 'Vivid never does this.',
} satisfies Record<RuleDecision, string>

/**
 * What Vivid may do without asking. A rule is a sentence and a decision. A Person's own rules
 * follow them everywhere; a Company's rules bind every member, and nobody's own rule can loosen
 * one: never beats ask, and ask beats allow, whoever wrote them. With no rule, Vivid asks before
 * anything that changes something outside itself.
 */
export function Rules({ me }: { me: MeResponse }) {
  const rules = useLive(live.rules)
  const [refusal, setRefusal] = useState<string | null>(null)
  if (!LiveState.$is('Ready')(rules)) return <Awaiting state={rules} />
  const mine = rules.value.rules.filter((rule) => RuleScope.guards.Personal(rule.scope))
  const companys = rules.value.rules.filter((rule) => RuleScope.guards.Company(rule.scope))
  const company = Workspace.guards.Company(me.workspace) ? me.workspace : null
  const admin = company !== null && company.role !== 'member'

  /** Saves a rule and says whether it was kept, so the form only clears what was really saved. */
  async function add(action: string, decision: RuleDecision, scope: RuleScope) {
    const result = await change((client) => client.CreateRule({ action, decision, scope }))
    setRefusal(Result.isFailure(result) ? 'That rule could not be saved.' : null)
    return Result.isSuccess(result)
  }
  const remove = (rule: Rule) => void change((client) => client.DeleteRule({ id: rule.id }))

  return (
    <>
      <Refusal message={refusal} />
      <Section
        title="Your rules"
        detail="They apply to Vivid when it acts for you, in every workspace."
      >
        {mine.length === 0 && (
          <Empty>No rules yet. Vivid asks before it changes anything outside itself.</Empty>
        )}
        {mine.map((rule) => (
          <RuleRow key={rule.id} rule={rule} onRemove={() => remove(rule)} />
        ))}
        <NewRule
          placeholder="e.g. Send email to people outside my company"
          onAdd={(action, decision) => add(action, decision, RuleScope.cases.Personal.make({}))}
        />
      </Section>
      {company !== null && (
        <Section
          title={`${company.company.name}’s rules`}
          detail="They bind everyone. A personal rule can make Vivid stricter, never looser."
        >
          {companys.length === 0 && <Empty>No company rules yet.</Empty>}
          {companys.map((rule) => (
            <RuleRow key={rule.id} rule={rule} onRemove={admin ? () => remove(rule) : undefined} />
          ))}
          {admin && (
            <NewRule
              placeholder="e.g. Delete anything in a shared drive"
              onAdd={(action, decision) => add(action, decision, RuleScope.cases.Company.make({}))}
            />
          )}
        </Section>
      )}
    </>
  )
}

function RuleRow({ rule, onRemove }: { rule: Rule; onRemove?: () => void }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-label text-ink">{rule.action}</div>
        <div className="text-label text-ink-3">
          {SAYS[rule.decision]} Set by {rule.createdBy.name}.
        </div>
      </div>
      {onRemove !== undefined && (
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  )
}

function NewRule({
  placeholder,
  onAdd,
}: {
  placeholder: string
  /** Resolves to whether the rule was saved. */
  onAdd: (action: string, decision: RuleDecision) => Promise<boolean>
}) {
  const [action, setAction] = useState('')
  const [decision, setDecision] = useState<RuleDecision>('Ask')
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (action.trim().length === 0) return
        // Cleared only once it is saved: a refused rule is still in the field to send again.
        void onAdd(action.trim(), decision).then((saved) => {
          if (saved) setAction('')
        })
      }}
    >
      <input
        value={action}
        onChange={(event) => setAction(event.currentTarget.value)}
        placeholder={placeholder}
        maxLength={200}
        className="h-8 min-w-48 flex-1 rounded-control bg-well px-3 text-label text-ink ring-line outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Segmented label="Decision" value={decision} options={DECISIONS} onChange={setDecision} />
      <Button type="submit" size="sm" variant="primary" disabled={action.trim().length === 0}>
        Add rule
      </Button>
    </form>
  )
}
