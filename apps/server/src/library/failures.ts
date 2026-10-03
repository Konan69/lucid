import * as Match from 'effect/Match'
import { Forbidden, InvalidRequest } from '@vivid/contracts'
import type { LibraryFailure } from './store.ts'

/** Domain failures become declared RPC variants without rewriting database failures. */
export const libraryFailure = (failure: LibraryFailure) =>
  Match.value(failure).pipe(
    Match.tags({
      LibraryShelfUnavailable: () =>
        new InvalidRequest({ message: 'Company shelf requires a Company workspace' }),
      LibraryMutationDenied: () =>
        new Forbidden({
          message: 'Only the contributor or a Company admin may change this Library record',
        }),
      LibraryFolderMismatch: () =>
        new InvalidRequest({ message: 'A Library record can only move within its own shelf' }),
      LibraryFolderCycle: () =>
        new InvalidRequest({
          message: 'A Library folder cannot contain itself or its descendants',
        }),
    }),
    Match.orElse((other) => other),
  )
