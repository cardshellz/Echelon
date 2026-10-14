import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { vi } from "vitest";
import type { ProcurementSettingsSnapshot } from "@shared/procurement/procurement-settings";
import { costGraphLockExecute } from "./cost-graph.fixture";

export function procurementSettingsFixture(overrides: Partial<ProcurementSettingsSnapshot> = {}) {
  return {
    id: 1, warehouseId: null, revision: 0,
    requireApproval: false, autoSendOnApprove: true, requireAcknowledgeBeforeReceive: false,
    hideIncotermsDomestic: true, enableShipmentTracking: true, autoPutawayLocation: true,
    autoCloseOnReconcile: true, oneClickReceiveStart: true, useNewPoEditor: false,
    useNewReorderCockpit: false, ...overrides,
  };
}

/** The lifecycle fixture explicitly supplies the canonical policy read while
 * retaining the graph-lock adapter's rejection of every other raw statement. */
export function costGraphAndProcurementSettingsExecute(overrides: Partial<ProcurementSettingsSnapshot> = {}) {
  const graphLock = costGraphLockExecute();
  return vi.fn(async (query: SQL) => {
    const statement = new PgDialect().sqlToQuery(query).sql.replace(/\s+/g, " ").trim();
    if (statement.startsWith('SELECT id, warehouse_id AS "warehouseId", procurement_policy_revision AS revision,')
      && statement.endsWith("FROM inventory.warehouse_settings WHERE warehouse_code='DEFAULT' FOR SHARE")) {
      return { rows: [procurementSettingsFixture(overrides)] };
    }
    return graphLock(query);
  });
}
