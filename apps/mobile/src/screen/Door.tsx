import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Option } from 'effect'
import { View } from 'react-native'
import { useReducedMotion } from 'react-native-reanimated'
import { origin } from '../data/origin'
import type { ServerAddress } from '../data/server'
import { Outside } from '../data/session'
import { useTheme } from '../theme'
import { navigationTheme, pushAnimation } from '../ui/stack'
import { GUTTER, Label } from '../ui/ui'
import { Address } from './door/Address'
import { Code } from './door/Code'
import { Create } from './door/Create'
import { Email } from './door/Email'
import { EntranceProvider, type DoorRoutes } from './door/Frame'
import { Password } from './door/Password'
import { Welcome } from './door/Welcome'

const Stack = createNativeStackNavigator<DoorRoutes>()

/**
 * The Vivid this phone signs in to: the one it last used, else the one this build was given
 * (`data/origin.ts`). A Person is never asked.
 */
const serverOf = (session: Outside): Option.Option<ServerAddress> =>
  Outside.$match(session, {
    Unset: () => origin,
    SignedOut: ({ server }) => Option.some(server),
    Expired: ({ server }) => Option.some(server),
  })

/**
 * The front door: everything a Person sees before they are signed in. Welcome, then their email,
 * then their password, each a screen on one native stack, so going on and coming back are the
 * platform's own push and pop. Creating an account and signing in with a code are quiet ways off
 * that path, each its own step.
 *
 * Nothing here knows about a session beyond which Vivid to ask: signing in adopts one
 * (`data/signing.ts`), which replaces this whole tree with the Person's Home.
 */
export function Door({ session }: { session: Outside }) {
  const { colors: c, dark } = useTheme()
  const still = useReducedMotion()
  const server = serverOf(session)
  // A build that was given no Vivid. A developer can say where one is; a Person cannot fix it.
  if (Option.isNone(server) && !__DEV__) return <Missing />
  const ended = Outside.$is('Expired')(session)
    ? Option.some('You were signed out. Sign in again to continue.')
    : Option.none<string>()
  const theme = navigationTheme(c, dark)
  if (Option.isNone(server)) {
    return (
      <NavigationContainer theme={theme}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Address" component={Address} />
        </Stack.Navigator>
      </NavigationContainer>
    )
  }
  return (
    // Keyed by the address: a developer changing it starts the door again at Welcome, with no
    // step still holding what was typed for the old one.
    <NavigationContainer key={server.value} theme={theme}>
      <EntranceProvider value={{ server: server.value, ended }}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: c.screen },
            animation: pushAnimation(still),
          }}
        >
          <Stack.Screen name="Welcome" component={Welcome} />
          <Stack.Screen name="Email" component={Email} />
          <Stack.Screen name="Password" component={Password} />
          <Stack.Screen name="Create" component={Create} />
          <Stack.Screen name="Code" component={Code} />
          {__DEV__ && <Stack.Screen name="Address" component={Address} />}
        </Stack.Navigator>
      </EntranceProvider>
    </NavigationContainer>
  )
}

/**
 * A release build that was given no Vivid to open. There is nothing a Person can type to fix
 * that, so it says what happened and what to do, and offers no field.
 */
function Missing() {
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityRole="alert"
      style={{
        flex: 1,
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: GUTTER + 8,
        backgroundColor: c.screen,
      }}
    >
      <Label accessibilityRole="header" size="largeTitle">
        Vivid is not set up on this phone
      </Label>
      <Label tone="ink-2">
        This copy of the app was not given a Vivid to open. Install it again from the link you were
        sent.
      </Label>
    </View>
  )
}
