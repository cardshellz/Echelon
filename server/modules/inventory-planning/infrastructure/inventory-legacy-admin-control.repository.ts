import type { Pool } from "pg";

import { pool as defaultPool } from "../../../db";
import { InventoryLegacyAdminControlService } from "../application/inventory-legacy-admin-control.service";
import {
  PostgresInventoryAvailabilityRuntimeAtpExecutor,
  type PostgresInventoryAvailabilityRuntimeTransaction,
} from "./inventory-availability-runtime-atp.repository";

type ClientPool = Pick<Pool, "connect">;

export function createInventoryLegacyAdminControlService(
  connectionPool: ClientPool = defaultPool,
): InventoryLegacyAdminControlService<PostgresInventoryAvailabilityRuntimeTransaction> {
  return new InventoryLegacyAdminControlService(
    new PostgresInventoryAvailabilityRuntimeAtpExecutor(connectionPool),
  );
}
