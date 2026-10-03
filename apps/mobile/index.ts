import { registerRootComponent } from 'expo'
import App from './src/App'
import { startUpdating } from './src/data/updating'

startUpdating()
registerRootComponent(App)
