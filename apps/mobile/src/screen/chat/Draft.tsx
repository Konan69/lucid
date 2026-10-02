import type { Shown } from '@vivid/contracts'
import { DRAFT_WORDS, draftIsLong } from '@vivid/state'
import { useState } from 'react'
import { View } from 'react-native'
import { commit } from '../../data/haptics'
import { useTheme } from '../../theme'
import { Copy } from '../../ui/Copy'
import { Share } from '../../ui/Share'
import { Sheet } from '../../ui/Sheet'
import { Button, HAIRLINE, Label, radius } from '../../ui/ui'
import { Frame } from './Frame'

/** Reading is separate from sending: long bodies open a sheet and historical drafts can still share. */
export function Draft({
  draft,
  live,
  onSay,
}: {
  draft: Extract<Shown, { readonly _tag: 'Draft' }>
  live: boolean
  onSay: (words: string) => void
}) {
  const { colors: c } = useTheme()
  const [open, setOpen] = useState(false)
  const words = DRAFT_WORDS[draft.kind]
  const long = draftIsLong(draft.body)
  return (
    <Frame title={words.name}>
      {(draft.to.length > 0 || draft.subject !== undefined) && (
        <View
          style={{
            borderTopWidth: HAIRLINE,
            borderBottomWidth: HAIRLINE,
            borderColor: c['line-2'],
          }}
        >
          {draft.to.length > 0 && <Header name="To" value={draft.to.join(', ')} />}
          {draft.subject !== undefined && <Header name="Subject" value={draft.subject} strong />}
        </View>
      )}
      <View
        style={{ padding: 14, borderRadius: radius.control, backgroundColor: c['surface-well'] }}
      >
        <Label selectable size="reading" numberOfLines={long ? 6 : undefined}>
          {draft.body}
        </Label>
      </View>
      {long && <Button label="Read all" onPress={() => setOpen(true)} />}
      {live && (
        <Button
          kind="primary"
          label={words.send}
          onPress={() => {
            commit()
            onSay(`${words.send}.`)
          }}
        />
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Copy name="the draft" read={() => draft.body} />
        <Share title={words.name} read={() => draft.body} />
      </View>
      {open && (
        <Sheet title={words.name} onClose={() => setOpen(false)}>
          <Label selectable size="reading">
            {draft.body}
          </Label>
        </Sheet>
      )}
    </Frame>
  )
}

/** One line of the draft's header: what it is, then its value, as in a mail app. */
function Header({
  name,
  value,
  strong = false,
}: {
  name: string
  value: string
  strong?: boolean
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 10 }}>
      <Label size="label" tone="ink-3" style={{ width: 56 }}>
        {name}
      </Label>
      <Label size={strong ? 'footnote' : 'label'} style={{ flex: 1 }}>
        {value}
      </Label>
    </View>
  )
}
