/**
 * Membership module: Echelon's single read-only member resolver (CI-03).
 *
 * Owns no tables. Reads the membership app's schema through one adapter, so
 * every Echelon feature finds members and their current plan the same way.
 * External callers import from here or the dedicated `*.api.ts` facades only.
 */
export * from "./member-resolution-contracts.api";
export * from "./runtime-readers.api";
