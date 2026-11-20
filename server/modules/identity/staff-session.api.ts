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
} from "./application/staff-session";
export {
  createStaffStreamObserver,
  STAFF_STREAM_QUEUE_LIMIT,
} from "./interfaces/http/staff-stream";
