/**
 * Staff session gate, credential lifecycle helpers, and stream observer facade for `identity` (CI-03).
 */
export {
  createStaffSessionGate,
  isCurrentStaffCredential,
  staffLifecyclePrincipal,
  staffSessionActor,
  clearStaffSession,
  readStaffLifecycleAccess,
} from "./staff-session";
export { createStaffStreamObserver } from "./staff-stream";
