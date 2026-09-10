import { z } from "zod";

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
  warehouses: z.array(z.object({ id, name: z.string() })),
  boxes: z.array(
    z.object({
      id,
      code: z.string(),
      name: z.string(),
      branding: boxBrandingSchema,
      isActive: z.boolean(),
      availabilityReviewed: z.boolean(),
      warehouseIds: z.array(id),
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
    lengthMm: id,
    widthMm: id,
    heightMm: id,
    outerLengthMm: id.nullable().default(null),
    outerWidthMm: id.nullable().default(null),
    outerHeightMm: id.nullable().default(null),
    tareWeightGrams: z.number().int().nonnegative().max(2_147_483_647),
    maxWeightGrams: id.nullable().default(null),
    costCents: z.number().int().nonnegative().max(2_147_483_647),
    fillFactorBps: z.number().int().positive().max(10000),
    isActive: z.boolean(),
    branding: boxBrandingSchema,
    warehouseIds: z.array(id).max(1000),
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
    if (new Set(box.warehouseIds).size !== box.warehouseIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["warehouseIds"],
        message: "Warehouse selections must be unique.",
      });
    }
  });
export type SaveCatalogBox = z.infer<typeof saveCatalogBoxSchema>;
