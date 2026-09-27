import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson } from "@shared/utils/canonical-json";
import { QuantityPublicationAdmissionError } from "../domain/quantity-publication-admission";

const id = z.number().int().positive().max(2_147_483_647);
const text = z.string().trim().min(1).max(120);
export const listingSetupZeroIntentSchema = z
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
            quantity: z.literal(0),
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
export type ListingSetupZeroIntent = z.infer<
  typeof listingSetupZeroIntentSchema
>;
export const listingSetupZeroInspectionInputSchema =
  listingSetupZeroIntentSchema.omit({
    operationId: true,
    publicationTargetId: true,
    expectedTargetRevision: true,
  });
export type ListingSetupZeroInspectionInput = z.infer<
  typeof listingSetupZeroInspectionInputSchema
>;
export interface ListingSetupZeroInspection {
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

export function validateListingSetupZeroIntent(
  input: unknown,
): Readonly<ListingSetupZeroIntent> {
  const parsed = listingSetupZeroIntentSchema.parse(input);
  parsed.items.sort(
    (left, right) => left.productVariantId - right.productVariantId,
  );
  parsed.items.forEach(Object.freeze);
  Object.freeze(parsed.items);
  return Object.freeze(parsed);
}

/** Called only by the inventory admission owner after its durable scope and
 * authority checks. Transport consumers can assert, never create, this proof. */
export function runWithListingSetupZeroAdmission<T>(
  intent: Readonly<ListingSetupZeroIntent>,
  work: () => Promise<T>,
): Promise<T> {
  if (admitted.getStore())
    throw new QuantityPublicationAdmissionError(
      "PUBLICATION_SETUP_NESTING_INVALID",
      "Initial listing admission cannot be nested.",
    );
  return admitted.run(canonicalJson(intent), work);
}

export function assertListingSetupZeroAdmission(
  input: ListingSetupZeroIntent,
): void {
  const intent = validateListingSetupZeroIntent(input);
  if (admitted.getStore() !== canonicalJson(intent)) {
    throw new QuantityPublicationAdmissionError(
      "PUBLICATION_SETUP_ADMISSION_REQUIRED",
      "Initial listing stock requires exact inventory-owned zero admission.",
    );
  }
}
