import { draftIn, noDrafts, readDrafts, withDraft, writeDrafts, type Drafts } from '@vivid/state'
import { Array as Arr, Effect, Option, Order, Stream } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { door, useDoor } from './door'
import { keepFile, recallFile } from './storage'

/**
 * What the Person has typed and not sent, kept on this phone. A composer shows what was left in
 * its place and writes each change straight back, so leaving a Thread, or the app being closed
 * under a half-written request, does not lose it. The model of a draft is shared with the web
 * (`@vivid/state`); this is only where the phone keeps them.
 *
 * The browser reads its store in one synchronous line. A phone's store answers a moment after
 * launch, so two things are held apart here and the drafts are derived from both: what the device
 * kept from its last run (`recalled`), and what has been written during this one (`written`).
 * Something typed before the store has answered is therefore never lost to it and never loses
 * what the store held: the two are laid together whenever either changes.
 *
 * They are device atoms (`door.ts`), not a session's: drafts outlive signing out, and each place
 * is named for its Person (`draftPlace`), so nobody is shown another Person's words.
 */

// A file, not the protected store: drafts can run to pages (see `keepFile`).
const FILE = 'drafts.json'

/** What this device kept from its last run. A store that cannot be read holds no drafts. */
const remembered = Effect.fn('Drafts.remembered')(function* () {
  const kept = yield* recallFile(FILE).pipe(
    // Nothing can be restored from a store that will not open, which is what a first launch is.
    Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<string>())),
  )
  return readDrafts(kept)
})

const recalled = Atom.keepAlive(Atom.make(remembered()))

/** One place's words exactly as its field holds them, and when they were last touched. */
interface Written {
  readonly text: string
  readonly at: number
}

/**
 * What has been written in each place during this run. It holds the field's exact text, which the
 * kept set does not: a draft that is only space is no draft there, but a Person who starts a
 * message with a new line must still see it. An emptied place stays here as empty, so sending a
 * message does not bring back what the store had for that place.
 */
const written = Atom.keepAlive(Atom.make<ReadonlyMap<string, Written>>(new Map()))

/** This run's writing by when each place was last touched, oldest first. */
const oldestFirst = Order.mapInput(Order.Number, ([, here]: readonly [string, Written]) => here.at)

/** The kept drafts with this run's writing laid over them, oldest first so the newest ends first. */
const laidOver = (kept: Drafts, writing: ReadonlyMap<string, Written>): Drafts =>
  Arr.sort(Array.from(writing), oldestFirst).reduce(
    (drafts, [where, { text, at }]) => withDraft(drafts, where, text, at),
    kept,
  )

/** What the store held, once it has answered; no drafts until then. */
const keptAtom = Atom.make((get) => AsyncResult.getOrElse(get(recalled), () => noDrafts))

/** Every draft as it stands now: what is written down whenever it changes. */
const draftsAtom = Atom.keepAlive(Atom.make((get) => laidOver(get(keptAtom), get(written))))

/** The words in one place right now: this run's when the place was written in, else the kept ones. */
const wordsIn = Atom.family((where: string) =>
  Atom.make((get) =>
    Option.match(Option.fromUndefinedOr(get(written).get(where)), {
      onNone: () => draftIn(get(keptAtom), where),
      onSome: (here) => here.text,
    }),
  ),
)

/**
 * One write of the whole set. A write the store refuses is not said: the words are still held for
 * this run and the next change writes the whole set again, and a notice on every keystroke would
 * be worse than the loss it reports.
 */
const writeDown = (text: string) =>
  keepFile(FILE, text).pipe(Effect.catchTag('StorageUnavailable', () => Effect.void))

/**
 * Every write the store needs, given what it held and the drafts as they change.
 *
 * What the store already holds goes first and is dropped, so a run in which nothing was typed
 * writes nothing, and one typed in before the store answered writes at once. There is one write
 * at a time: while one is on its way only the newest state waits behind it, so a fast typist costs
 * the store two writes, not one per letter, and an older state can never land after a newer one.
 */
const writes = (kept: Drafts, drafts: Stream.Stream<Drafts>) =>
  Stream.concat(Stream.succeed(kept), drafts).pipe(
    Stream.map(writeDrafts),
    Stream.changes,
    Stream.drop(1),
    Stream.buffer({ capacity: 1, strategy: 'sliding' }),
    Stream.mapEffect(writeDown),
  )

/**
 * Writes the drafts down each time they change, for as long as something holds this atom. Nothing
 * is written until the store has been read, or the first keystroke of a run would replace
 * everything the device had kept with that one draft.
 */
const writtenDown = Atom.make((get) =>
  Stream.unwrap(Effect.map(get.result(recalled), (kept) => writes(kept, get.stream(draftsAtom)))),
)

// Held for the life of the app, like the device's other subscriptions (`appearance.ts`): the store
// is read at launch, before any screen asks, and every change is written whichever screen made it.
door.mount(writtenDown)

export const draft = {
  /** The words left in a place right now, for code that runs after a screen has waited. */
  in: (where: string): string => door.get(wordsIn(where)),
  /** Keeps a place's words as they now stand; words that are only space remove its draft. */
  keep: (where: string, text: string) =>
    door.set(written, new Map(door.get(written)).set(where, { text, at: Date.now() })),
}

/**
 * The words in a place, for its composer. The composer draws this value and holds no copy, so what
 * is on screen is what is kept, and a draft the store hands over just after the screen appeared is
 * shown without anything copying it into state.
 */
export const useDraft = (where: string): string => useDoor(wordsIn(where))
