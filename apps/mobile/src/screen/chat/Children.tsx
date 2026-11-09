import { ChildFailure, ChildRunDetail, ChildRunResult, type ChildRun } from '@vivid/contracts'
import { helpers } from '@vivid/state'
import { Option } from 'effect'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { useState } from 'react'
import { View } from 'react-native'
import {
  followUpHelper,
  stopHelper,
  useHelperFollowUp,
  useHelperResult,
  useHelperStop,
} from '../../data/children'
import { LiveState, useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { Field, Label, Press, radius } from '../../ui/ui'
import { Words } from './Words'

/**
 * The helpers one step of Vivid's reply started, under that step: a quiet line naming them, then
 * one row each with what it was asked to do and where it stands. A row opens to the helper's
 * answer and a field to send it more; while it works it has a Stop of its own. Drawn in the reply's quiet voice, as
 * `AskedFirst` is (`Cards.tsx`): no card. The browser draws the same (`apps/web/src/screen/thread/Children.tsx`).
 */
export function Children({ runs }: { runs: ReadonlyArray<ChildRun> }) {
  const stop = useHelperStop()
  if (runs.length === 0) return null
  return (
    <View style={{ marginTop: 8, gap: 2 }}>
      <Label size="caption" tone="ink-3">
        {runs.length === 1
          ? 'A helper took part of this'
          : `${runs.length} helpers took parts of this`}
      </Label>
      {runs.map((run) => (
        <Helper key={run.id} run={run} stop={stop} />
      ))}
    </View>
  )
}

/** One helper's row: its brief and state, opening to its result, with Stop while it works. */
function Helper({ run, stop }: { run: ChildRun; stop: helpers.Reading }) {
  const { colors: c } = useTheme()
  const data = useLiveData()
  const [open, setOpen] = useState(false)
  const refusal = helpers.refusalFor(stop, run.id)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Press
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((shown) => !shown)}
          containerStyle={{ flex: 1 }}
          style={({ pressed }) => ({
            minHeight: 46,
            marginHorizontal: -8,
            paddingHorizontal: 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            borderRadius: radius.row,
            backgroundColor: pressed ? c['row-hover'] : 'transparent',
          })}
        >
          <Chevron pointerEvents="none" size={16} strokeWidth={1.7} color={c.chevron} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label tone="ink" numberOfLines={1}>
              {run.brief}
            </Label>
            <Label size="label" tone="ink-3" numberOfLines={1}>
              {helpers.helperStatus(run)}
            </Label>
          </View>
        </Press>
        {helpers.stoppable(run) && (
          <Press
            accessibilityRole="button"
            accessibilityLabel={`Stop: ${run.brief}`}
            accessibilityState={{ disabled: helpers.isWaiting(stop) }}
            disabled={helpers.isWaiting(stop)}
            onPress={() => stopHelper(data, run.id)}
            style={({ pressed }) => ({
              minHeight: 44,
              minWidth: 44,
              paddingHorizontal: 10,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.row,
              backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
              opacity: helpers.isWaiting(stop) ? 0.4 : 1,
            })}
          >
            <Label size="label" tone="ink-2" style={{ fontWeight: '600' }}>
              Stop
            </Label>
          </Press>
        )}
      </View>
      {Option.isSome(refusal) && (
        <Label size="label" tone="status-danger" style={{ paddingLeft: 24 }}>
          {refusal.value}
        </Label>
      )}
      {open && <Opened run={run} />}
      {open && helpers.followable(run) && <More key={helpers.roundIn(run)} run={run} />}
    </View>
  )
}

/** What an opened row shows: the answer once there is one, or how far it got. */
function Opened({ run }: { run: ChildRun }) {
  const reading = useHelperResult(run)
  return (
    <View style={{ paddingLeft: 24, paddingBottom: 8 }}>
      {LiveState.$match(reading, {
        Loading: () => (
          <Label size="label" tone="ink-3">
            Opening…
          </Label>
        ),
        Failed: () => (
          <Label size="label" tone="ink-3">
            Its answer could not be opened just now.
          </Label>
        ),
        Ready: ({ value }) =>
          ChildRunDetail.match(value, {
            Active: () => (
              <Label size="label" tone="ink-3">
                Still working. Its answer comes here.
              </Label>
            ),
            Ended: ({ result }) => <Answer result={result} />,
          }),
      })}
    </View>
  )
}

/** A finished helper's answer in its own words, or one line of why it has none. */
function Answer({ result }: { result: ChildRunResult }) {
  return ChildRunResult.match(result, {
    Completed: ({ text }) => <Words text={text} />,
    Failed: ({ failure }) => (
      <Label size="label" tone="ink-3">
        {ChildFailure.guards.DeadlinePassed(failure)
          ? 'It ran out of time before it had an answer.'
          : 'It could not finish.'}
      </Label>
    ),
    Stopped: ({ by }) => (
      <Label size="label" tone="ink-3">
        {by === 'Person' ? 'Stopped before it finished.' : 'Vivid stopped it before it finished.'}
      </Label>
    ),
  })
}

/**
 * A field to send an opened helper more: more to do, a correction or a new direction, which it
 * takes as its next turn with everything it knew (`FollowUpChildRun`). Keyed by the helper's round,
 * so once the follow-up lands the field starts empty; a refused one keeps the words. The browser
 * draws the same (`apps/web/src/screen/thread/Children.tsx` `More`).
 */
function More({ run }: { run: ChildRun }) {
  const { colors: c } = useTheme()
  const data = useLiveData()
  const [draft, setDraft] = useState('')
  const sending = useHelperFollowUp()
  const refusal = helpers.followRefusalFor(sending, run.id)
  const words = draft.trim()
  const held = words.length === 0 || helpers.isSending(sending)
  const send = () => {
    if (words.length > 0) followUpHelper(data, run.id, words)
  }
  return (
    <View style={{ paddingLeft: 24, paddingBottom: 8, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Field
          accessibilityLabel="Tell this helper more"
          placeholder="Tell this helper more"
          maxLength={8000}
          value={draft}
          onChangeText={setDraft}
          returnKeyType="send"
          onSubmitEditing={send}
          style={{ flex: 1 }}
        />
        <Press
          accessibilityRole="button"
          accessibilityLabel={`Send to: ${run.brief}`}
          accessibilityState={{ disabled: held }}
          disabled={held}
          onPress={send}
          style={({ pressed }) => ({
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 10,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.row,
            backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
            opacity: held ? 0.4 : 1,
          })}
        >
          <Label size="label" tone="ink-2" style={{ fontWeight: '600' }}>
            Send
          </Label>
        </Press>
      </View>
      {Option.isSome(refusal) && (
        <Label size="label" tone="status-danger">
          {refusal.value}
        </Label>
      )}
    </View>
  )
}
