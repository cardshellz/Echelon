import { z } from "zod";
import { workEvidenceIdSchema } from "./warehouse-assembly-work";

const positiveInt = z.number().int().positive().max(2_147_483_647);
export const assemblyPackageReviewSchema = z.object({
  taskId: workEvidenceIdSchema,
  orderId: positiveInt,
  warehouseId: positiveInt,
  readOnly: z.literal(true),
  closesPackage: z.literal(false),
  // Relationship discovery is not proof of packages lacking persisted links.
  discoveryComplete: z.literal(false),
  packages: z.array(z.object({
    labelId: workEvidenceIdSchema,
    provider: z.string().min(1).max(40),
    providerPackageId: z.string().min(1).max(200),
    trackingNumber: z.string().min(1).max(200),
    labelStatus: z.enum(["active", "unknown", "voided", "superseded"]),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["observed_contents", "review_required"]),
    issues: z.array(z.string().min(1).max(100)).max(100),
    items: z.array(z.object({
      sourceShipmentItemId: positiveInt, orderItemId: positiveInt,
      sku: z.string().min(1).max(100), quantity: positiveInt,
    }).strict()).max(500),
  }).strict()).max(100),
}).strict();
export type AssemblyPackageReview = z.infer<typeof assemblyPackageReviewSchema>;
