import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { ExtractionFaulted, PdfLocked, PdfUnreadable } from './contract.ts'

/** unpdf 1.8.1 pdfjs.mjs BaseException/wrapReason own name/code; only these names prove content rejection. */
const ContentRejection = Schema.Union([
  Schema.Struct({ name: Schema.Literal('InvalidPDFException') }),
  Schema.Struct({ name: Schema.Literal('PasswordException'), code: Schema.Literals([1, 2]) }),
]).pipe(Schema.toTaggedUnion('name'))
const decodeContentRejection = Schema.decodeUnknownOption(ContentRejection)

/**
 * The sole unpdf rejection ingress: discard raw details and decode the two documented content
 * names. unpdf 1.8.1 index.mjs:90-97 loads before finally; page/destroy/import faults retry.
 * Schema.ts:6126 supplies exhaustive matching for this external name discriminator.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- unpdf rejection ingress is decoded immediately; mismatch intentionally carries no provider details.
export const rejectionOf = (cause: unknown): PdfUnreadable | PdfLocked | ExtractionFaulted =>
  Option.match(decodeContentRejection(cause), {
    onNone: () => new ExtractionFaulted(),
    onSome: (content) =>
      ContentRejection.match(content, {
        InvalidPDFException: () => new PdfUnreadable(),
        PasswordException: () => new PdfLocked(),
      }),
  })
