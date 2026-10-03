import { useState, type Ref } from 'react'
import { View, type TextInput, type TextInputProps } from 'react-native'
import { Eye, EyeOff } from 'lucide-react-native'
import { Field, IconButton } from '../../ui/ui'

/**
 * A password field with the way to see what was typed inside it, at its end. Typing a password
 * blind on a phone keyboard is how it comes out wrong; the toggle is one tap and stays where the
 * thumb already is.
 */
export function Secret({ ref, ...props }: TextInputProps & { ref?: Ref<TextInput> }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <View>
      <Field
        ref={ref}
        {...props}
        secureTextEntry={!revealed}
        autoCapitalize="none"
        autoCorrect={false}
        // Clear of the toggle, which is a 44-point target 4 points in from the field's edge.
        style={{ paddingRight: 52 }}
      />
      <View style={{ position: 'absolute', right: 4, top: 4 }}>
        <IconButton
          icon={revealed ? EyeOff : Eye}
          label={revealed ? 'Hide password' : 'Show password'}
          onPress={() => setRevealed((shown) => !shown)}
        />
      </View>
    </View>
  )
}
