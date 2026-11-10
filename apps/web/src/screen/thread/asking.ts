import type { InputAnswer, InputRequest, InputRequestId } from '@vivid/contracts'
import { asking as model } from '@vivid/state'
import { Effect, Option, Result, type Array as Arr } from 'effect'
import { useCallback, useReducer, useRef, useState } from 'react'
import { act } from '../../data/app'
import { changing } from '../../data/live'

/**
 * The request from Vivid whose banner is up over the composer, and answering it. Every decision in
 * it is the one the phone makes (`asking`, `@vivid/state`); this holds the state those decisions
 * read, as `useAsking` in `apps/mobile/src/screen/Chat.tsx` does on the phone.
 *
 * `up` is the request that should be up (`upOf`). The banner holds one request at a time and lets
 * go of it only once it has slid away, so the next request's banner arrives after the last has
 * settled (`holdOf`). What it holds follows `up` while rendering, which is React's own way to
 * follow a value without an effect: a free banner takes the request that is up.
 *
 * The answers to a request's questions go to the server together, once the banner has one for
 * each (`Choices.tsx`). They are kept as on their way until the request's record says it is
 * answered: it is the record that takes the banner away, not the call returning, so rows that woke
 * up between the two could not be pressed a second time.
 *
 * Each send is one `Attempt`, and what ends is that attempt and nothing else: a request can be
 * settled somewhere else while its answers from here are still in flight, and that late refusal
 * must not wake the rows of the request being answered now. So the tries are one value moved by
 * what happens to a try (`triesAfter`), never set from the far side of the call. One request also
 * takes one send at a time (`mayAnswer`). Which requests have a call in flight is kept in a ref,
 * read when a press happens and never while rendering, because two presses can land before
 * React has drawn the first.
 *
 * A refusal is kept with what to say and the question it names (`refusedOf`), against the
 * request it was for, and is not said about any other.
 *
 * Where the Person is in the request's questions is kept here too (`kept`, `draftingOf`), and
 * not in the banner, because the composer has a part in one case: a question that offers no
 * options is answered from it (`written`). In every other case what is sent from the composer is
 * an ordinary message, which the server answers by withdrawing the request.
 */
export function useAsking(up: Option.Option<InputRequest>) {
  const [held, setHeld] = useState(up)
  const [{ pending, refused }, tried] = useReducer(model.triesAfter, model.untried)
  // Where the Person is in the questions of the request the banner holds (`draftingOf`).
  const [kept, setKept] = useState<Option.Option<model.Kept>>(Option.none())
  const flying = useRef(new Set<InputRequestId>())
  const attempts = useRef(0)
  const hold = model.holdOf(held, up)
  if (model.Hold.$is('Free')(hold) && Option.isSome(up)) setHeld(up)
  // One function for the life of the Thread: the banner is handed it, and is not drawn again for
  // a function that only looks new.
  const release = useCallback(() => setHeld(Option.none()), [])

  /**
   * Sends a request's answers, one for each of its questions in their order. It is one function
   * for the life of the Thread: it reads only what does not change between renders.
   */
  const answer = useCallback(
    (id: InputRequestId, answers: Arr.NonEmptyReadonlyArray<InputAnswer>) => {
      if (!model.mayAnswer(flying.current, id)) return
      flying.current.add(id)
      attempts.current += 1
      const attempt: model.Attempt = { attempt: attempts.current, id }
      tried(model.Tried.Began({ tried: attempt }))
      void act(
        Effect.gen(function* () {
          const result = yield* changing((client) => client.AnswerInput({ id, answers }))
          flying.current.delete(id)
          if (Result.isSuccess(result)) return
          tried(model.Tried.Failed({ tried: attempt, failure: result.failure }))
        }),
      )
    },
    [],
  )

  /** What is kept against one request, when it is about that request. */
  const about = <One extends { readonly id: InputRequestId }>(
    one: Option.Option<One>,
    id: InputRequestId,
  ) => Option.filter(one, (value) => value.id === id)

  /** Where the Person is in one request's questions, with a new refusal's question put back up. */
  const draftingIn = (request: InputRequest) => model.draftingOf(request, kept, refused)

  // The request whose banner is up, when one is. It is the server's own record, the same object
  // until the server answers again, so what is remembered by it below stays the same meanwhile.
  const raised = model.Hold.$is('Up')(hold) ? hold.request : undefined

  /**
   * Takes words sent from the composer as the answer to the question that is up, when they are
   * that (`asking.replyOf`): only a question that offers no options and takes words of the
   * Person's own makes the composer its field. The banner then moves on, and from the last
   * question every answer is sent. It says whether the words were taken; when they were not,
   * they are an ordinary message and the Thread sends them as one.
   *
   * It is the same function until the request, what is kept for it or the last refusal
   * changes: the composer is given it, and is not drawn again for a function that only looks
   * new (`Composer` is drawn only when what it is given changes).
   */
  const written = useCallback(
    (words: string): boolean => {
      if (raised === undefined) return false
      const asked = { request: raised, drafting: model.draftingOf(raised, kept, refused) }
      return model.Reply.$match(model.replyOf(Option.some(asked), words), {
        Message: () => false,
        Answer: ({ drafting, step }) => {
          setKept(
            Option.some({
              id: raised.id,
              drafting: model.Step.$is('Next')(step) ? step.asking : drafting,
              heeded: Option.map(refused, (one) => one.attempt),
            }),
          )
          if (model.Step.$is('Send')(step)) answer(raised.id, step.answers)
          return true
        },
      })
    },
    [raised, kept, refused, answer],
  )

  /**
   * Moves on from the question that is up, when it has an answer: to the next question, or, from
   * the last, by sending every answer (`asking.advance`). It is what the composer's button and
   * Enter in an empty composer do while a request is up; the banner has no button of its own.
   * Like `written`, it is the same function until what it reads changes.
   */
  const onward = useCallback(() => {
    if (raised === undefined) return
    const drafting = model.draftingOf(raised, kept, refused)
    model.Step.$match(model.advance(raised.questions, drafting), {
      Stay: () => undefined,
      Next: ({ asking: next }) =>
        setKept(
          Option.some({
            id: raised.id,
            drafting: next,
            heeded: Option.map(refused, (one) => one.attempt),
          }),
        ),
      Send: ({ answers }) => answer(raised.id, answers),
    })
  }, [raised, kept, refused, answer])

  /** Goes back to the question before the one that is up, with every pick kept. */
  const backward = useCallback(() => {
    if (raised === undefined) return
    setKept(
      Option.some({
        id: raised.id,
        drafting: model.back(model.draftingOf(raised, kept, refused)),
        heeded: Option.map(refused, (one) => one.attempt),
      }),
    )
  }, [raised, kept, refused])

  return {
    hold,
    draftingIn,
    /** Keeps where the Person is in one request, as having seen the last refusal. */
    draft: (id: InputRequestId, drafting: model.Asking) =>
      setKept(Option.some({ id, drafting, heeded: Option.map(refused, (one) => one.attempt) })),
    written,
    onward,
    backward,
    /** Where the Person is in the request whose banner is up: what the composer's footer reads. */
    progress:
      // An Integration's form has its own Send and Skip (`Form.tsx`), so the composer's footer
      // has nothing to move on from.
      raised === undefined || raised.integration !== null
        ? Option.none()
        : Option.some(model.progressOf(raised.questions, draftingIn(raised))),
    /**
     * A question of Vivid's is waiting on this Person, whether or not its banner is up yet, so
     * what is sent is its reply. An Integration's is answered by its own form, so the composer
     * stays "Message Vivid" for it.
     */
    waiting: Option.exists(up, (request) => request.integration === null),
    /** The answers to the request whose banner is up are on their way. */
    answering: raised !== undefined && Option.isSome(about(pending, raised.id)),
    /** The answers to one request are on their way. */
    sendingTo: (id: InputRequestId) => Option.isSome(about(pending, id)),
    /** What to say when the last answers to the request that is up did not go through. */
    refusal: raised === undefined ? Option.none() : about(refused, raised.id),
    answer,
    release,
  }
}

/** What `useAsking` answers with: what the banner and the composer are both given. */
export type Asking = ReturnType<typeof useAsking>
