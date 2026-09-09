import { z } from "zod";

// These are the existing shipping-engine business channels, not marketplace
// store connections. A dropship vendor's eBay store is still dropship here.
export const fulfillmentChannelSchema = z.enum([
  "shopify",
  "internal",
  "ebay",
  "dropship",
]);
export type FulfillmentChannel = z.infer<typeof fulfillmentChannelSchema>;
const cents = z.number().int().nonnegative().safe();
export const percentageChargeSchema = z
  .object({
    bps: z.number().int().min(0).max(100000),
    fixedCents: cents,
    minCents: cents.nullable(),
    maxCents: cents.nullable(),
  })
  .strict()
  .refine(
    (fee) =>
      fee.minCents === null ||
      fee.maxCents === null ||
      fee.minCents <= fee.maxCents,
    "Minimum charge cannot exceed maximum charge.",
  );
export const programChargesSchema = z
  .object({
    markup: percentageChargeSchema,
    insurance: percentageChargeSchema,
  })
  .strict();
export type ProgramCharges = z.infer<typeof programChargesSchema>;
export const NO_PROGRAM_CHARGES: ProgramCharges = {
  markup: { bps: 0, fixedCents: 0, minCents: null, maxCents: null },
  insurance: { bps: 0, fixedCents: 0, minCents: null, maxCents: null },
};
export const saveProgramChargesSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    commandId: z.string().uuid(),
    charges: programChargesSchema,
  })
  .strict();
export const saveBoxSuiteSchema = z
  .object({
    id: z.number().int().positive().optional(),
    expectedRevision: z.number().int().nonnegative(),
    commandId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    boxIds: z.array(z.number().int().positive()).min(1).max(1000),
  })
  .strict()
  .refine(
    (suite) => new Set(suite.boxIds).size === suite.boxIds.length,
    "A box can only appear once in a suite.",
  );
export const savePackagingAssignmentSchema = z
  .object({
    channel: fulfillmentChannelSchema,
    warehouseId: z.number().int().positive().nullable(),
    suiteId: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    commandId: z.string().uuid(),
  })
  .strict();
export interface ProgramChargeEvidence {
  revision: number;
  baseCents: number;
  markupCents: number;
  insuranceCents: number;
  totalCents: number;
  charges: ProgramCharges;
}
export interface BoxSuiteSummary {
  id: number;
  name: string;
  revision: number;
  boxIds: number[];
}
export interface PackagingAssignment {
  channel: FulfillmentChannel;
  warehouseId: number | null;
  suiteId: number;
  revision: number;
}
export interface PackagingConfiguration {
  suites: BoxSuiteSummary[];
  assignments: PackagingAssignment[];
  boxes: { id: number; code: string; name: string; isActive: boolean }[];
  warehouses: { id: number; name: string }[];
}
export const saveFulfillmentServiceSchema = z
  .object({
    channel: fulfillmentChannelSchema,
    serviceLevelId: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    commandId: z.string().uuid(),
  })
  .strict();
export const saveDropshipProgramSchema = z
  .object({
    warehouseId: z.number().int().positive().nullable(),
    rateBookId: z.number().int().positive(),
    expectedProgramId: z.number().int().positive().nullable(),
    commandId: z.string().uuid(),
  })
  .strict();
export interface DropshipSharedShippingConfig {
  runtimeMode?: "legacy" | "test" | "live";
  runtimeConfigurationError?: string | null;
  packaging: PackagingConfiguration;
  programs: { id: number; name: string }[];
  assignments: { warehouseId: number | null; rateBookId: number | null }[];
  serviceLevels: { id: number; name: string }[];
  selectedService: { id: number; revision: number } | null;
  configuredChannelId: number | null;
}
export const packagingConfigurationSchema: z.ZodType<PackagingConfiguration> =
  z.object({
    suites: z.array(
      z.object({
        id: z.number().int().positive(),
        name: z.string(),
        revision: z.number().int().positive(),
        boxIds: z.array(z.number().int().positive()),
      }),
    ),
    assignments: z.array(
      z.object({
        channel: fulfillmentChannelSchema,
        warehouseId: z.number().int().positive().nullable(),
        suiteId: z.number().int().positive(),
        revision: z.number().int().positive(),
      }),
    ),
    boxes: z.array(
      z.object({
        id: z.number().int().positive(),
        code: z.string(),
        name: z.string(),
        isActive: z.boolean(),
      }),
    ),
    warehouses: z.array(
      z.object({ id: z.number().int().positive(), name: z.string() }),
    ),
  });
export const dropshipSharedShippingConfigSchema: z.ZodType<DropshipSharedShippingConfig> =
  z.object({
    packaging: packagingConfigurationSchema,
    programs: z.array(
      z.object({ id: z.number().int().positive(), name: z.string() }),
    ),
    assignments: z.array(
      z.object({
        warehouseId: z.number().int().positive().nullable(),
        rateBookId: z.number().int().positive().nullable(),
      }),
    ),
    serviceLevels: z.array(
      z.object({ id: z.number().int().positive(), name: z.string() }),
    ),
    selectedService: z
      .object({
        id: z.number().int().positive(),
        revision: z.number().int().positive(),
      })
      .nullable(),
    configuredChannelId: z.number().int().positive().nullable(),
    runtimeMode: z.enum(["legacy", "test", "live"]).optional(),
    runtimeConfigurationError: z.string().nullable().optional(),
  });
