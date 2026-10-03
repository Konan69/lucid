import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { setProvider } from '@flue/runtime'
import { Config, Effect, Option } from 'effect'
import { script } from './rehearsal/script.ts'

/** Each request gets a fresh SDK queue: concurrent Threads never share pending steps or counters. */
function fresh() {
  const faux = fauxProvider({
    provider: 'rehearsal',
    models: [{ id: 'script', name: 'Rehearsal script' }],
    tokenSize: { min: 4, max: 4 },
  })
  faux.setResponses([script])
  return faux.provider
}

// This module is Flue's synchronous provider bootstrap boundary, matching openrouter.ts.
// oxlint-disable-next-line vivid/no-runpromise-in-library
const model = Effect.runSync(Config.option(Config.String('VIVID_MODEL')))
if (Option.isSome(model) && model.value.startsWith('rehearsal/')) {
  setProvider({
    ...fresh(),
    /** Faux consumes one queued response; isolate the queue for every public stream call. */
    stream: (selected, context, options) => fresh().stream(selected, context, options),
    /** Flue uses streamSimple for normal turns; it receives the same context-only script. */
    streamSimple: (selected, context, options) => fresh().streamSimple(selected, context, options),
  })
}
