import * as PgTypes from '@effect/sql-pg/PgTypes'
import { Result, Schema } from 'effect'

/** PostgreSQL's regclass type OID, absent from the rc.116 PgTypes.OID catalogue. */
const REGCLASS_TYPE = 2205

/** PgTypes.decode accepts only binary result columns (rc.116 PgTypes.ts:1686-1688). */
const BINARY_FORMAT = 1
const decodeIdentifier = Schema.decodeUnknownResult(Schema.Int)

/**
 * Regclass carries the same unsigned four-byte identifier as oid. Reuse the SDK's binary codec
 * in both directions, then narrow its unknown output at this SDK ingress without a type cast.
 */
const regclass: PgTypes.Codec<number> = {
  encode: (value) => PgTypes.encode(value, PgTypes.OID.oid),
  decode: (bytes) =>
    PgTypes.decode(bytes, PgTypes.OID.oid, BINARY_FORMAT).pipe(
      Result.flatMap((value) =>
        decodeIdentifier(value).pipe(
          Result.mapError(
            () => new PgTypes.CodecError({ message: 'Invalid PostgreSQL relation identifier' }),
          ),
        ),
      ),
    ),
}

/**
 * Each client gets an isolated public registry. Effect rc.116 Migrator.ts:137 selects regclass
 * to check for its migration table; the driver's unregistered-type UTF-8 fallback
 * (PgTypes.ts:1644) otherwise kills the connection for some relation identifiers on restart.
 * Remove this compatibility codec when the pinned driver supplies native regclass support.
 */
export const postgresCodecs = (): PgTypes.Registry => {
  const registry = PgTypes.makeRegistry()
  registry.register(REGCLASS_TYPE, regclass)
  return registry
}
