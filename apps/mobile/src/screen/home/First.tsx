import { Workspace, type MeResponse, type Suggestion } from '@vivid/contracts'
import { View } from 'react-native'
import { useTheme } from '../../theme'
import { Face, HAIRLINE, Label, Press, radius } from '../../ui/ui'

/** The Person's first name, when their name has one to take. */
const firstName = (me: MeResponse): string => me.person.name.trim().split(/\s+/u, 1).join('')

/**
 * What the first screen shows before there is any Thread: Vivid, and things the Person could
 * say. There is nothing to set up and nothing to choose. The suggestions are the server's, drawn
 * from this Person's own Tasks, Routines and Library; choosing one puts its words in the
 * composer, where they can be changed before they are sent.
 */
export function First({
  me,
  suggestions,
  onChoose,
}: {
  me: MeResponse
  suggestions: ReadonlyArray<Suggestion>
  onChoose: (text: string) => void
}) {
  const { colors: c } = useTheme()
  const name = firstName(me)
  return (
    <View
      style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 36, paddingBottom: 24 }}
    >
      <Face size={56} mood="happy" />
      <Label accessibilityRole="header" size="largeTitle" style={{ marginTop: 20 }}>
        {name.length === 0 ? 'Hi.' : `Hi, ${name}.`}
      </Label>
      <Label tone="ink-3" style={{ marginTop: 4, textAlign: 'center' }}>
        {Workspace.match(me.workspace, {
          Personal: () => 'What should I take off your plate?',
          Company: ({ company }) => `What should I take off your plate at ${company.name}?`,
        })}
      </Label>
      <View style={{ width: '100%', maxWidth: 520, marginTop: 28, gap: 8 }}>
        {suggestions.map((suggestion) => (
          <Press
            key={suggestion.text}
            accessibilityRole="button"
            accessibilityHint="Puts this in the message field"
            onPress={() => onChoose(suggestion.text)}
            style={({ pressed }) => ({
              paddingHorizontal: 16,
              paddingVertical: 14,
              gap: 3,
              borderRadius: radius.card,
              borderWidth: HAIRLINE,
              borderColor: c['line-2'],
              backgroundColor: pressed ? c['surface-3'] : c['surface-2'],
            })}
          >
            <Label size="footnote" style={{ fontWeight: '400' }}>
              {suggestion.text}
            </Label>
            <Label size="caption" tone="ink-3">
              {suggestion.reason}
            </Label>
          </Press>
        ))}
      </View>
    </View>
  )
}
