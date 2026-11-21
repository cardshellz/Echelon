/**
 * Public DB-client-injected projection runner contract for CLI scripts and jobs.
 */
export {
  runControlTowerProjectionJob,
  type ControlTowerProjectionJobResult,
} from "./application/control-tower-v2.job";
export {
  CONTROL_TOWER_SOURCE_ADAPTERS,
  getControlTowerSourceAdapter,
} from "./infrastructure/control-tower-v2.sources";
export type {
  ControlTowerSourceAdapter,
  QueryClient,
} from "./domain/control-tower-v2.domain";
