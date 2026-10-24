import { Match, Schema } from 'effect'
import type { StorageUnavailable } from './storage'

/**
 * How an account request fails, and what the front door says when it does, beside which field.
 * The failures are declared here, free of any device module, so the one map from failure to
 * words can be tested alone; `account.ts` raises them. No screen writes its own sentence.
 *
 * The words are plain and say what to do. They never name a server, an address or a status.
 */

/**
 * Why an account request was refused, as the cases a Person can act on differently. The front
 * door turns each into its own sentence beside the right field (`refusal.ts`).
 *
 * - `WrongCredentials`: the email and password do not match an account.
 * - `EmailTaken`: an account with this email already exists.
 * - `TooManyAttempts`: the server is rate-limiting this device.
 * - `NoSession`: signed in, but the answer carried no token for a phone to keep.
 * - `Other`: anything else; `message` is the server's own wording when it gave one.
 */
export const RefusalReason = Schema.Literals([
  'WrongCredentials',
  'EmailTaken',
  'TooManyAttempts',
  'NoSession',
  'Other',
])
export type RefusalReason = typeof RefusalReason.Type

/** The server answered and said no. `reason` is what kind of no; `message` is a sentence for it. */
export class AccountRefused extends Schema.TaggedError<AccountRefused>()(
  'AccountRefused',
  { reason: RefusalReason, message: Schema.String },
  { title: 'Account request refused' },
) {}

/** A rate limit or server outage answered; replaying an idempotent sign-out may succeed. */
export class AccountUnavailable extends Schema.TaggedError<AccountUnavailable>()(
  'AccountUnavailable',
  { status: Schema.Int, message: Schema.String },
  { title: 'Account server temporarily unavailable' },
) {}

/** No answer came back at all: the wrong address, no network, or a server that is not running. */
export class AccountUnreachable extends Schema.TaggedError<AccountUnreachable>()(
  'AccountUnreachable',
  { message: Schema.String },
  { title: 'Account server unreachable' },
) {}

/** Everything signing in can fail with: the account request, or keeping the session afterwards. */
export type EntryFailure =
  | AccountRefused
  | AccountUnavailable
  | AccountUnreachable
  | StorageUnavailable

/** Where a sentence is shown: under the field it is about, or above the button when it is about none. */
export type Beside = 'password' | 'form'

export interface Said {
  readonly beside: Beside
  readonly words: string
}

const REFUSED = {
  WrongCredentials: { beside: 'password', words: 'That password is not right.' },
  EmailTaken: { beside: 'form', words: 'That email already has an account. Go back and sign in.' },
  TooManyAttempts: { beside: 'form', words: 'Too many tries. Wait a minute and try again.' },
  NoSession: { beside: 'form', words: 'Vivid could not sign this phone in. Try again.' },
  Other: { beside: 'form', words: 'That did not work. Try again.' },
} as const satisfies Record<RefusalReason, Said>

export const saidFor = (failure: EntryFailure): Said =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      AccountRefused: ({ reason }): Said => REFUSED[reason],
      AccountUnavailable: ({ status }): Said =>
        status === 429 ? REFUSED.TooManyAttempts : { beside: 'form', words: REFUSED.Other.words },
      AccountUnreachable: (): Said => ({
        beside: 'form',
        words: 'Can’t reach Vivid. Check your connection and try again.',
      }),
      StorageUnavailable: (): Said => ({
        beside: 'form',
        words: 'This phone could not save your sign-in. Try again.',
      }),
    }),
  )
