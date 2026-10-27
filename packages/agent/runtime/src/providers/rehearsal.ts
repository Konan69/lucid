import type { Provider } from '@earendil-works/pi-ai'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { script } from './rehearsal/script.ts'

/**
 * The scripted models. `script` answers at once. `paced` streams the same answers at 20 tokens a
 * second (four-character tokens, so a 400-character answer takes about five seconds), long enough
 * for Pi to commit partial replies every 100 ms, so a recovery proof can stop the runtime or the
 * server in the middle of a reply (`pi-ai` `providers/faux` `tokensPerSecond`).
 */
const MODELS = [
  { id: 'script', name: 'Rehearsal script' },
  { id: 'paced', name: 'Rehearsal script, paced' },
]

/** Each request gets a fresh SDK queue; concurrent Threads never share pending steps or counters. */
function fresh(model: string) {
  const options = {
    api: 'rehearsal',
    provider: 'rehearsal',
    models: MODELS,
    tokenSize: { min: 4, max: 4 },
  }
  const faux =
    model === 'paced' ? fauxProvider({ ...options, tokensPerSecond: 20 }) : fauxProvider(options)
  faux.setResponses([script])
  return faux.provider
}

/** Export a value only; the composition root installs it for an explicit rehearsal/ selection. */
export const provider: Provider = {
  ...fresh('script'),
  /** Faux consumes one queued response; isolate the queue for every public stream call. */
  stream: (selected, context, options) => fresh(selected.id).stream(selected, context, options),
  /** Simple streams need the same context-derived scene and request-local queue. */
  streamSimple: (selected, context, options) =>
    fresh(selected.id).streamSimple(selected, context, options),
}
