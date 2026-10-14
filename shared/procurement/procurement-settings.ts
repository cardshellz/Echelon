import { z } from "zod";

export const PROCUREMENT_SETTING_KEYS = [
  "requireApproval", "autoSendOnApprove", "requireAcknowledgeBeforeReceive",
  "hideIncotermsDomestic", "enableShipmentTracking", "autoPutawayLocation",
  "autoCloseOnReconcile", "oneClickReceiveStart", "useNewPoEditor", "useNewReorderCockpit",
] as const;
export type ProcurementSettingKey = typeof PROCUREMENT_SETTING_KEYS[number];

export const procurementSettingsSchema = z.object({
  requireApproval: z.boolean(), autoSendOnApprove: z.boolean(),
  requireAcknowledgeBeforeReceive: z.boolean(), hideIncotermsDomestic: z.boolean(),
  enableShipmentTracking: z.boolean(), autoPutawayLocation: z.boolean(),
  autoCloseOnReconcile: z.boolean(), oneClickReceiveStart: z.boolean(),
  useNewPoEditor: z.boolean(), useNewReorderCockpit: z.boolean(),
});
export type ProcurementSettings = z.infer<typeof procurementSettingsSchema>;
// PostgreSQL integer revision: bounded explicitly before incrementing it.
export const procurementPolicyRevisionSchema = z.number().int().min(0).max(2_147_483_647);
export const procurementSettingsSnapshotSchema = procurementSettingsSchema.extend({
  revision: procurementPolicyRevisionSchema,
}).passthrough();
export type ProcurementSettingsSnapshot = z.infer<typeof procurementSettingsSnapshotSchema>;

const updateSchema = z.object({ key: z.enum(PROCUREMENT_SETTING_KEYS), value: z.boolean() }).strict();
const expectedRevision = procurementPolicyRevisionSchema;
export const procurementSettingsCommandSchema = z.union([
  updateSchema.extend({ expectedRevision }).strict().transform(({ key, value, expectedRevision }) => ({
    expectedRevision, updates: [{ key, value }],
  })),
  z.object({ expectedRevision, updates: z.array(updateSchema).min(1).max(PROCUREMENT_SETTING_KEYS.length) }).strict(),
]).superRefine((command, context) => {
  const keys = new Set<ProcurementSettingKey>();
  command.updates.forEach((update, index) => {
    if (keys.has(update.key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["updates", index, "key"], message: "A setting may appear only once in a command" });
    keys.add(update.key);
  });
});
export type ProcurementSettingsCommand = z.infer<typeof procurementSettingsCommandSchema>;
