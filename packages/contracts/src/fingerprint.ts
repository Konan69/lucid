import * as Hash from 'effect/Hash'
import * as Schema from 'effect/Schema'
import { ContractFingerprint, RuntimeAdmissionReceipt, RuntimeRefusal } from './runtime.js'
import { RuntimeAdmissionBody } from './threads.js'

/**
 * The fingerprint of the admission wire: the JSON Schema documents of the body the server sends,
 * the receipt it reads back and the refusal it reads otherwise, hashed once when this module
 * loads. The server and a cell compare theirs (`CONTRACT_HEADER`, `GET /contract`) to tell a
 * Worker built from other schemas, which is what made every send fail from 8 November 2026: the
 * published Worker predated the server's admission body and refused it, and nothing said why.
 *
 * Effect's `Hash.string` (32 bits) is enough here: it tells two builds apart, it does not guard
 * anything, and it runs the same in the server, the Worker and a test without a crypto module.
 */
export const contractFingerprint: ContractFingerprint = ContractFingerprint.make(
  (
    Hash.string(
      JSON.stringify(
        [RuntimeAdmissionBody, RuntimeAdmissionReceipt, RuntimeRefusal].map((schema) =>
          Schema.toJsonSchemaDocument(schema),
        ),
      ),
    ) >>> 0
  )
    .toString(16)
    .padStart(8, '0'),
)
