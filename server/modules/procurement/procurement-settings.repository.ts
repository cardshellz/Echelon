import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { PROCUREMENT_SETTING_KEYS, procurementSettingsSnapshotSchema, type ProcurementSettingKey, type ProcurementSettingsSnapshot } from "@shared/procurement/procurement-settings";
import { ProcurementSettingsError } from "./procurement-settings.policy";

export interface ProcurementSettingsTransaction { execute(query: SQL): Promise<{ rows: unknown[] }> }

const COLUMNS: Record<ProcurementSettingKey, string> = {
  requireApproval: "require_approval", autoSendOnApprove: "auto_send_on_approve",
  requireAcknowledgeBeforeReceive: "require_acknowledge_before_receive", hideIncotermsDomestic: "hide_incoterms_domestic",
  enableShipmentTracking: "enable_shipment_tracking", autoPutawayLocation: "auto_putaway_location",
  autoCloseOnReconcile: "auto_close_on_reconcile", oneClickReceiveStart: "one_click_receive_start",
  useNewPoEditor: "use_new_po_editor", useNewReorderCockpit: "use_new_reorder_cockpit",
};
const projection = sql.join(PROCUREMENT_SETTING_KEYS.map(key => sql`${sql.identifier(COLUMNS[key])} AS ${sql.identifier(key)}`), sql`, `);
const rowSchema = procurementSettingsSnapshotSchema.extend({ id: z.number().int().positive().safe(), warehouseId: z.null() });
export type ProcurementSettingsRecord = { id: number; settings: ProcurementSettingsSnapshot };

/** All policy readers use the exact global DEFAULT row. FOR SHARE is held by
 * purchasing approval/issue; FOR UPDATE serializes edits with those decisions. */
export async function readProcurementSettings(
  tx: ProcurementSettingsTransaction,
  lock?: "share" | "update",
): Promise<ProcurementSettingsRecord> {
  const locking = lock === "update" ? sql`FOR UPDATE` : lock === "share" ? sql`FOR SHARE` : sql``;
  const result = await tx.execute(sql`
    SELECT id, warehouse_id AS "warehouseId", procurement_policy_revision AS revision, ${projection}
    FROM inventory.warehouse_settings WHERE warehouse_code='DEFAULT' ${locking}
  `);
  if (result.rows.length !== 1) {
    throw new ProcurementSettingsError("Exactly one global DEFAULT procurement settings row is required. Review the warehouse configuration.", 409, "PROCUREMENT_SETTINGS_CONFIGURATION_INVALID");
  }
  const parsed = rowSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    throw new ProcurementSettingsError("The global procurement policy contains invalid stored values. Review the warehouse configuration.", 409, "PROCUREMENT_SETTINGS_SOURCE_INVALID");
  }
  const { id, warehouseId: _warehouseId, ...settings } = parsed.data;
  return { id, settings };
}

export async function saveProcurementSettings(
  tx: ProcurementSettingsTransaction,
  record: ProcurementSettingsRecord,
  after: ProcurementSettingsSnapshot,
  actorId: string,
  at: Date,
  commandKey: string,
): Promise<void> {
  const assignments = PROCUREMENT_SETTING_KEYS.map(key => sql`${sql.identifier(COLUMNS[key])}=${after[key]}`);
  const result = await tx.execute(sql`
    UPDATE inventory.warehouse_settings SET ${sql.join(assignments, sql`, `)},
      procurement_policy_revision=${after.revision}, updated_at=${at}
    WHERE id=${record.id} AND warehouse_code='DEFAULT' AND procurement_policy_revision=${record.settings.revision}
    RETURNING id
  `);
  if (result.rows.length !== 1) throw new Error("Locked procurement policy update did not affect its canonical row");
  await tx.execute(sql`
    INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES (${at},'AUDIT',${actorId},'procurement.settings.updated',${`warehouse_settings:${record.id}`},
      ${canonicalJson({ before: record.settings, after })}::jsonb,
      ${canonicalJson({ commandKey, policy: "DEFAULT", previousRevision: record.settings.revision, revision: after.revision })}::jsonb)
  `);
}
