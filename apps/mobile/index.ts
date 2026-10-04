import { registerRootComponent } from 'expo'
import App from './src/App'
import { watchFaults } from './src/data/fault'
import { startUpdating } from './src/data/updating'

watchFaults()
startUpdating()
registerRootComponent(App)
