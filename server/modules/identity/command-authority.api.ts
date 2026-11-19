/**
 * Transaction-scoped command authority reader for `identity` (CI-03).
 * Deliberately free of database singletons; callers pass their active transaction executor.
 */
export { readCommandAuthorityActor } from "./infrastructure/command-authority.repository";
export {
  commandAuthorityActorSchema,
  type CommandAuthorityActor,
} from "./domain/command-authority";
