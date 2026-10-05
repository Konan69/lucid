import { draftIn, withDraft, type Drafts } from '@vivid/state'
import { Array as Arr, Data, Option } from 'effect'

/**
 * What a Person has typed during this run of the app, before and after the phone's store has said
 * what it kept from the last one. Pure functions; `drafts.ts` holds the one value and writes it
 * down.
 *
 * The phone's store answers a moment after launch, and a Person can already be typing by then. So
 * there are two states, and they are held differently on purpose:
 *
 * - `Unread`: the store has not answered. Every place written in is held, including a place that
 *   was emptied, because nobody knows yet what the store holds for it: the empty entry is what
 *   stops a sent message's words coming back when the store answers. This lasts for the moment a
 *   file read takes, so nothing here needs a limit.
 * - `Read`: the store has answered and the two were laid together, once. From here there is one
 *   set of drafts and nothing behind it, so an emptied place is simply gone from it and needs no
 *   marker, and the set is the shared model's own (`withDraft`), which lets the oldest go beyond
 *   what a device keeps. It used to be a map that grew by one entry for every place ever typed or
 *   emptied in, for as long as the app stayed open, and was sorted whole on every keystroke.
 */
export type Writing = Data.TaggedEnum<{
  Unread: {
    /** This run's words by place, in the order the places were last written in, oldest first. */
    readonly written: ReadonlyMap<string, string>
  }
  Read: {
    readonly drafts: Drafts
    /**
     * Words that are only space, in the one place they were just typed. They are no draft and are
     * never kept, but the field must go on showing them: a Person who starts a message with a new
     * line would otherwise have it taken out from under the cursor. Only the place being typed in
     * can need this, so writing anywhere else lets it go.
     */
    readonly blank: Option.Option<{ readonly where: string; readonly text: string }>
  }
}>
export const Writing = Data.taggedEnum<Writing>()

/** How every run starts: nothing typed, and the store not yet read. */
export const unread: Writing = Writing.Unread({ written: new Map() })

/** Words a field holds that are only space: something to show, and nothing to keep. */
const blankIn = (where: string, text: string) =>
  text.length > 0 && text.trim().length === 0 ? Option.some({ where, text }) : Option.none()

/**
 * The writing with one place's words as they now stand.
 *
 * Before the store has answered, the place moves to the end of the map so the map stays in the
 * order things were written: that order is the order they are laid over the store's drafts.
 */
export const keeping = (writing: Writing, where: string, text: string, now: number): Writing =>
  Writing.$match(writing, {
    Unread: ({ written }) => {
      const next = new Map(written)
      next.delete(where)
      return Writing.Unread({ written: next.set(where, text) })
    },
    Read: ({ drafts }) =>
      Writing.Read({ drafts: withDraft(drafts, where, text, now), blank: blankIn(where, text) }),
  })

/**
 * The writing once the store has said what it kept: this run's words laid over the store's, in
 * the order they were written, so the newest ends first and an emptied place takes the store's
 * words for it away. Everything typed before the answer is dated by the answer; it was all typed
 * in the moment before it. A store that answers twice changes nothing the second time.
 */
export const answered = (writing: Writing, kept: Drafts, now: number): Writing =>
  Writing.$match(writing, {
    Read: () => writing,
    Unread: ({ written }) => {
      const typed = Array.from(written)
      return Writing.Read({
        drafts: typed.reduce((drafts, [where, text]) => withDraft(drafts, where, text, now), kept),
        blank: Option.flatMap(Arr.last(typed), ([where, text]) => blankIn(where, text)),
      })
    },
  })

/**
 * The writing with its drafts changed by something other than typing: the server's answer to a
 * save, or another device's draft arriving (`@vivid/state` `sync.ts`). Before the store has
 * answered there are no drafts to change; what arrived waits for it there.
 */
export const revising = (writing: Writing, change: (drafts: Drafts) => Drafts): Writing =>
  Writing.$match(writing, {
    Unread: () => writing,
    Read: ({ drafts, blank }) => Writing.Read({ drafts: change(drafts), blank }),
  })

/** The words in one place right now, exactly as its field should show them. */
export const wordsIn = (writing: Writing, where: string): string =>
  Writing.$match(writing, {
    // No words is what a place has until someone writes there or the store says otherwise.
    Unread: ({ written }) => Option.getOrElse(Option.fromUndefinedOr(written.get(where)), () => ''),
    Read: ({ drafts, blank }) =>
      Option.match(
        Option.filter(blank, (here) => here.where === where),
        { onNone: () => draftIn(drafts, where), onSome: (here) => here.text },
      ),
  })

/**
 * The drafts the store should hold, once it has answered. There are none to give it before that:
 * a store told about this run's words alone would lose everything it had kept.
 */
export const draftsOf = (writing: Writing): Option.Option<Drafts> =>
  Writing.$match(writing, {
    Unread: () => Option.none(),
    Read: ({ drafts }) => Option.some(drafts),
  })
