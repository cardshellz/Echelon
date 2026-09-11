import { z } from "zod";
import { boxDimensionMmSchema } from "./dimensions";

const id = z.number().int().positive().max(2_147_483_647);
export const boxBrandingSchema = z.enum([
  "unclassified",
  "unbranded",
  "branded",
]);
export const packagingRequirementSchema = z.enum(["any", "unbranded"]);
export type BoxBranding = z.infer<typeof boxBrandingSchema>;
export type PackagingRequirement = z.infer<typeof packagingRequirementSchema>;

export const packagingOverrideSchema = z
  .object({ warehouseId: id, suiteId: id })
  .strict();
export const saveChannelPackagingSchema = z
  .object({
    channelId: id,
    expectedRevision: z.number().int().nonnegative(),
    commandId: z.string().uuid(),
    defaultSuiteId: id,
    requirement: packagingRequirementSchema,
    overrides: z.array(packagingOverrideSchema).max(1000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.overrides.map((o) => o.warehouseId)).size ===
      value.overrides.length,
    "A warehouse can have only one suite override.",
  );
export type SaveChannelPackaging = z.infer<typeof saveChannelPackagingSchema>;

export const channelPackagingPolicySchema = z
  .object({
    channelId: id,
    revision: z.number().int().positive(),
    defaultSuiteId: id,
    requirement: packagingRequirementSchema,
    overrides: z.array(packagingOverrideSchema),
  })
  .strict();
export type ChannelPackagingPolicy = z.infer<
  typeof channelPackagingPolicySchema
>;

export const packagingPolicyOverviewSchema = z.object({
  channels: z.array(
    z.object({
      id,
      name: z.string(),
      provider: z.string(),
      status: z.string(),
      legacyProfile: z.enum(["shopify", "ebay", "internal", "dropship"]),
    }),
  ),
  policies: z.array(channelPackagingPolicySchema),
  warehouses: z.array(
    z.object({
      id,
      name: z.string(),
      packagingRevision: z.number().int().nonnegative().default(0),
    }),
  ),
  boxes: z.array(
    z.object({
      id,
      code: z.string(),
      name: z.string(),
      branding: boxBrandingSchema,
      isActive: z.boolean(),
      availabilityReviewed: z.boolean(),
      warehouseIds: z.array(id),
      configurationRevision: z.number().int().positive().default(1),
    }),
  ),
  suites: z.array(
    z.object({
      id,
      name: z.string(),
      revision: z.number().int().positive(),
      archived: z.boolean(),
      boxIds: z.array(id),
    }),
  ),
  pricing: z.array(
    z.object({
      channelId: id,
      warehouseId: id.nullable(),
      name: z.string(),
      purpose: z.string(),
    }),
  ),
  warehouseAssignments: z.array(
    z.object({ channelId: id, warehouseId: id, enabled: z.boolean() }),
  ),
});
export type PackagingPolicyOverview = z.infer<
  typeof packagingPolicyOverviewSchema
>;

export const saveCatalogBoxSchema = z
  .object({
    id: id.optional(),
    code: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["box", "mailer", "envelope"]),
    lengthMm: boxDimensionMmSchema,
    widthMm: boxDimensionMmSchema,
    heightMm: boxDimensionMmSchema,
    outerLengthMm: boxDimensionMmSchema.nullable().default(null),
    outerWidthMm: boxDimensionMmSchema.nullable().default(null),
    outerHeightMm: boxDimensionMmSchema.nullable().default(null),
    tareWeightGrams: z.number().int().nonnegative().max(2_147_483_647),
    maxWeightGrams: id.nullable().default(null),
    costCents: z.number().int().nonnegative().max(2_147_483_647),
    fillFactorBps: z.number().int().positive().max(10000),
    isActive: z.boolean(),
    branding: boxBrandingSchema,
    expectedRevision: z.number().int().nonnegative(),
    commandId: z.string().uuid(),
  })
  .strict()
  .superRefine((box, ctx) => {
    const outer = [box.outerLengthMm, box.outerWidthMm, box.outerHeightMm];
    if (
      !outer.every((n) => n === null) &&
      (outer.some((n) => n === null) ||
        box.outerLengthMm! < box.lengthMm ||
        box.outerWidthMm! < box.widthMm ||
        box.outerHeightMm! < box.heightMm)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["outerLengthMm"],
        message:
          "Supply all outer dimensions, at least as large as inner dimensions.",
      });
    }
  });
export type SaveCatalogBox = z.infer<typeof saveCatalogBoxSchema>;

const revisionTarget = z
  .object({ id, revision: z.number().int().nonnegative() })
  .strict();
const targets = z
  .array(revisionTarget)
  .min(1)
  .max(1000)
  .refine(
    (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
    "Selections must be unique.",
  );
export const bulkBoxBrandingSchema = z
  .object({
    commandId: z.string().uuid(),
    boxes: targets,
    branding: boxBrandingSchema,
  })
  .strict();
export type BulkBoxBranding = z.infer<typeof bulkBoxBrandingSchema>;
export const warehouseAvailabilitySchema = z
  .object({
    commandId: z.string().uuid(),
    warehouses: targets,
    boxIds: z
      .array(id)
      .min(1)
      .max(1000)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Box selections must be unique.",
      ),
    available: z.boolean(),
    // A suite is a reviewed snapshot for this command, never ongoing stock inheritance.
    sourceSuite: revisionTarget.optional(),
  })
  .strict()
  .refine(
    (value) => value.warehouses.length * value.boxIds.length <= 100000,
    "Select at most 100,000 warehouse/box pairs per operation.",
  );
export type WarehouseAvailability = z.infer<typeof warehouseAvailabilitySchema>;
export const warehouseSuiteAssignmentSchema = z
  .object({
    commandId: z.string().uuid(),
    channelId: id,
    expectedRevision: z.number().int().nonnegative(),
    initialPolicy: z
      .object({ defaultSuiteId: id, requirement: packagingRequirementSchema })
      .strict()
      .optional(),
    warehouseIds: z
      .array(id)
      .min(1)
      .max(1000)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Warehouse selections must be unique.",
      ),
    suiteId: id.nullable(),
    replaceExisting: z.boolean(),
  })
  .strict()
  .refine(
    (value) => (value.expectedRevision === 0) === Boolean(value.initialPolicy),
    "Supply explicit program defaults only when creating a new policy.",
  );
export type WarehouseSuiteAssignment = z.infer<
  typeof warehouseSuiteAssignmentSchema
>;
export const packagingBulkResultSchema = z.object({
  changed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type PackagingBulkResult = z.infer<typeof packagingBulkResultSchema>;
