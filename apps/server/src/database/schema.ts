/**
 * The identity owner's schema: what Better Auth reads and writes, and the two product tables that
 * are keyed to it directly. `drizzle.config.ts` generates `./drizzle` from exactly these tables;
 * everything else belongs to the product owner in `product.ts`, which migrates second so its
 * foreign keys to a Person or a Company always find their target.
 */
export {
  accountTable,
  deviceCodeTable,
  personTable,
  sessionTable,
  verificationTable,
} from '../auth/tables.ts'
export { companyTable, invitationTable, membershipTable } from '../companies/tables.ts'
export { projectTable } from '../projects/tables.ts'
export { settingsTable } from '../settings/tables.ts'
