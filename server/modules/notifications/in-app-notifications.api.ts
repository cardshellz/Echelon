/**
 * Narrow internal API facade for domain callers emitting in-app staff notifications (`CI-03`).
 *
 * User-scoped feed reads, read-acknowledgements, and preference mutations remain
 * internal to `server/modules/notifications`.
 */
export { notify, type NotifyPayload } from "./notifications.service";
