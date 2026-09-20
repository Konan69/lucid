import { InvalidRequest } from '@vivid/contracts/rpc'

/** Collapses domain validation failures into the single public invalid-request variant. */
export const invalidRequest = (failure: { readonly message: string }) =>
  new InvalidRequest({ message: failure.message })
