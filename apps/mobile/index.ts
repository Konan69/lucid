import { registerRootComponent } from 'expo'
import App from './src/App'
import { watchFaults } from './src/data/fault'
import { reporting, startTelemetry } from './src/data/telemetry'
import { startUpdating } from './src/data/updating'

// First, so an error in anything started below is reported. `watchFaults` comes after it on
// purpose: each takes the global error handler and calls the one before it (`data/telemetry.ts`).
startTelemetry()
watchFaults()
startUpdating()
registerRootComponent(reporting(App))
