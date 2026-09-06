import { z } from "zod";

export const WORK_CAPABILITIES = [
  "receiving", "inspection", "putaway", "replenishment", "picking",
  "consolidation", "assembly", "packing", "dispatch", "returns", "inventory_control",
] as const;
export const workCapabilitySchema = z.enum(WORK_CAPABILITIES);
export type WorkCapability = z.infer<typeof workCapabilitySchema>;
export const WORK_CAPABILITY_LABELS: Record<WorkCapability, string> = {
  receiving: "Receiving", inspection: "Inspection / QA", putaway: "Putaway / movement",
  replenishment: "Replenishment / decant", picking: "Picking", consolidation: "Consolidation / sort",
  assembly: "Assembly / kitting", packing: "Packing", dispatch: "Dispatch",
  returns: "Returns / rework", inventory_control: "Inventory control",
};

export const warehouseIdSchema = z.number().int().positive().max(2_147_483_647);
const codeSchema = z.string().trim().min(1).max(30).regex(/^[A-Z0-9][A-Z0-9_-]*$/);
const capabilitiesSchema = z.array(workCapabilitySchema).min(1).max(WORK_CAPABILITIES.length)
  .refine((values) => new Set(values).size === values.length, "Capabilities must be unique");

export const workStationSchema = z.object({
  id: z.string().uuid(),
  code: codeSchema,
  name: z.string().trim().min(1).max(100),
  locationId: warehouseIdSchema,
  capabilities: capabilitiesSchema,
  enabled: z.boolean(),
}).strict();
export type WorkStation = z.infer<typeof workStationSchema>;

// These govern workflow presentation and responsibility, NEVER posting authority.
// Physical evidence, role/scope checks, and inventory invariants are not toggles.
export const workProfileSchema = z.object({
  inbound: z.enum(["receive_and_stow", "staged"]),
  replenishment: z.enum(["same_operator", "team_queue"]),
  assemblyPacking: z.enum(["combined", "separate"]),
  assignment: z.enum(["claim_on_start", "dispatcher"]),
  handoff: z.literal("on_responsibility_change"),
}).strict();
export type WorkProfile = z.infer<typeof workProfileSchema>;
export function smallTeamProfile(): WorkProfile {
  return {
    inbound: "receive_and_stow", replenishment: "same_operator", assemblyPacking: "combined",
    assignment: "claim_on_start", handoff: "on_responsibility_change",
  };
}

export const workScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("warehouse") }).strict(),
  z.object({ kind: z.literal("zone"), zone: z.string().trim().min(1).max(10) }).strict(),
  z.object({ kind: z.literal("stations"), stationIds: z.array(z.string().uuid()).min(1).max(500)
    .refine((ids) => new Set(ids).size === ids.length, "Station IDs must be unique") }).strict(),
]);
export const workAccessSchema = z.object({
  userId: z.string().trim().min(1).max(255),
  capabilities: capabilitiesSchema,
  scope: workScopeSchema,
}).strict();
export type WorkAccess = z.infer<typeof workAccessSchema>;

export const workConfigurationSchema = z.object({
  profile: workProfileSchema,
  stations: z.array(workStationSchema).max(500),
  access: z.array(workAccessSchema).max(2000),
}).strict().superRefine((config, context) => {
  for (const [field, values] of [
    ["station IDs", config.stations.map((station) => station.id)],
    ["station codes", config.stations.map((station) => station.code)],
    ["employee scopes", config.access.map((access) => access.userId)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: `Duplicate ${field}` });
    }
  }
  const ids = new Set(config.stations.map((station) => station.id));
  for (const access of config.access) {
    if (access.scope.kind === "stations" && access.scope.stationIds.some((id) => !ids.has(id))) {
      context.addIssue({ code: "custom", message: "Employee scope references an unknown station" });
    }
  }
});
export type WorkConfiguration = z.infer<typeof workConfigurationSchema>;
export function emptyWorkConfiguration(): WorkConfiguration {
  return { profile: smallTeamProfile(), stations: [], access: [] };
}

export const saveWorkConfigurationSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  commandId: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
  configuration: workConfigurationSchema,
}).strict();
export type SaveWorkConfiguration = z.infer<typeof saveWorkConfigurationSchema>;

export const workRevisionSchema = z.object({
  warehouseId: warehouseIdSchema,
  revision: z.number().int().nonnegative(),
  configuration: workConfigurationSchema,
  // No route or command can activate execution in this foundation package.
  executionStatus: z.literal("not_connected"),
  savedAt: z.string().datetime().nullable(),
  savedBy: z.string().nullable(),
  reason: z.string().nullable(),
}).strict();
export type WorkRevision = z.infer<typeof workRevisionSchema>;

export const workContextRequestSchema = z.object({
  capability: workCapabilitySchema,
  stationId: z.string().uuid().nullable(),
  locationId: warehouseIdSchema,
}).strict();
export type WorkContextRequest = z.infer<typeof workContextRequestSchema>;
export const workContextPreviewSchema = z.object({
  eligible: z.boolean(),
  reason: z.enum(["eligible", "inactive_user", "missing_permission", "missing_scope", "outside_scope",
    "invalid_location", "invalid_station", "station_capability_missing"]),
  revision: z.number().int().nonnegative(),
  executionAllowed: z.literal(false),
}).strict();
export type WorkContextPreview = z.infer<typeof workContextPreviewSchema>;

export const workSetupSchema = z.object({
  warehouse: z.object({ id: warehouseIdSchema, name: z.string(), code: z.string() }).strict(),
  revision: workRevisionSchema,
  locations: z.array(z.object({ id: warehouseIdSchema, code: z.string(), zone: z.string().nullable(), active: z.boolean() }).strict()),
  employees: z.array(z.object({ id: z.string(), name: z.string(), active: z.boolean() }).strict()),
  canConfigure: z.boolean(),
  canManageAccess: z.boolean(),
}).strict();
export type WorkSetup = z.infer<typeof workSetupSchema>;
