import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson } from "@shared/utils/canonical-json";
import { QuantityPublicationAdmissionError } from "../domain/quantity-publication-admission";

const id = z.number().int().positive().max(2_147_483_647);
const text = z.string().trim().min(1).max(120);
export const listingSetupIntentSchema = z
  .object({
    operationId: text,
    publicationTargetId: id,
    expectedTargetRevision: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine(
        (value) =>
          /^[1-9][0-9]{0,18}$/.test(value) &&
          BigInt(value) <= BigInt("9223372036854775807"),
        "Revision exceeds PostgreSQL bigint",
      ),
    channelId: id,
    channelConnectionId: id,
    partnerId: text,
    environment: z.enum(["production", "sandbox"]),
    shipNodeId: text,
    items: z
      .array(
        z
          .object({
            productVariantId: id,
            sku: z.string().trim().min(1).max(100),
            quantity: z.number().int().min(0).max(2_147_483_647),
            // Supplied only by the listing owner after verifying a settled prior
            // operation, its exact retained identity, and a fresh provider 404.
            recreation: z
              .object({
                sourceOperationId: z.string().uuid(),
                sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
                previousExternalProductId: text.nullable(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(250)
      .refine(
        (items) =>
          new Set(items.map((item) => item.productVariantId)).size ===
          items.length,
        "Variants must be distinct",
      )
      .refine(
        (items) => new Set(items.map((item) => item.sku)).size === items.length,
        "Seller SKUs must be distinct",
      ),
  })
  .strict();
export type ListingSetupIntent = z.infer<typeof listingSetupIntentSchema>;
// Callers select identities, never quantities. Accept the old zero placeholder
// for queued/older internal callers; it is discarded before inventory resolves
// the current canonical quantity under publication admission.
export const listingSetupRequestSchema = listingSetupIntentSchema.superRefine(
  (value, context) => {
    for (const item of value.items)
      if (item.quantity !== 0)
        context.addIssue({
          code: "custom",
          path: ["items"],
          message:
            "Initial quantities must be resolved by inventory, not supplied by the caller.",
        });
  },
);
export const listingSetupInspectionInputSchema = listingSetupIntentSchema
  .omit({
    operationId: true,
    publicationTargetId: true,
    expectedTargetRevision: true,
  })
  .refine(
    (value) => value.items.every((item) => item.quantity === 0),
    "Initial quantities are resolved by inventory.",
  );
export type ListingSetupInspectionInput = z.infer<
  typeof listingSetupInspectionInputSchema
>;
export interface ListingSetupInspection {
  ready: boolean;
  publicationTargetId: number | null;
  targetRevision: string | null;
  blockers: Array<{
    code: string;
    message: string;
    productVariantId: number | null;
  }>;
  variants: Array<{
    productVariantId: number;
    ready: boolean;
    blockers: Array<{ code: string; message: string }>;
  }>;
}
const admitted = new AsyncLocalStorage<string>();

export function validateListingSetupIntent(
  input: unknown,
): Readonly<ListingSetupIntent> {
  const parsed = listingSetupIntentSchema.parse(input);
  parsed.items.sort(
    (left, right) => left.productVariantId - right.productVariantId,
  );
  parsed.items.forEach((item) => {
    if (item.recreation) Object.freeze(item.recreation);
    Object.freeze(item);
  });
  Object.freeze(parsed.items);
  return Object.freeze(parsed);
}

/** Called only by the inventory admission owner after its durable scope and
 * authority checks. Transport consumers can assert, never create, this proof. */
export function runWithListingSetupAdmission<T>(
  intent: Readonly<ListingSetupIntent>,
  work: () => Promise<T>,
): Promise<T> {
  if (admitted.getStore())
    throw new QuantityPublicationAdmissionError(
      "PUBLICATION_SETUP_NESTING_INVALID",
      "Initial listing admission cannot be nested.",
    );
  return admitted.run(canonicalJson(intent), work);
}

export function assertListingSetupAdmission(input: ListingSetupIntent): void {
  const intent = validateListingSetupIntent(input);
  if (admitted.getStore() !== canonicalJson(intent)) {
    throw new QuantityPublicationAdmissionError(
      "PUBLICATION_SETUP_ADMISSION_REQUIRED",
      "Initial listing stock requires exact inventory-owned quantity admission.",
    );
  }
}
