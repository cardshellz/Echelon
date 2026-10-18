import { z } from "zod";

// Receipt quantities are persisted as PostgreSQL integer counts.
const MAX_IMPORT_COUNT = 2_147_483_647;
const countSchema = z.union([
  z.string().refine((value) => /^[0-9]*$/.test(value.trim()), "must contain a whole count")
    .transform((value) => Number(value.trim())),
  z.number(),
]).nullish().transform((value) => value ?? 0)
  .pipe(z.number().int().min(0).max(MAX_IMPORT_COUNT));
const optionalText = z.string().trim().nullish();

export const receivingImportRowSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required"),
  qty: countSchema,
  location: optionalText,
  damaged_qty: countSchema,
  unit_cost: z.union([z.string(), z.number().finite()]).nullish(),
  barcode: optionalText,
  notes: optionalText,
});
export type ReceivingImportRowInput = z.input<typeof receivingImportRowSchema>;

export const receivingImportRowIssueSchema = z.object({
  row: z.number().int().positive(),
  code: z.enum(["RECEIVING_IMPORT_DUPLICATE_IDENTITY", "RECEIVING_IMPORT_AMBIGUOUS_EXISTING_LINE"]),
  message: z.string().min(1),
});
export type ReceivingImportRowIssue = z.infer<typeof receivingImportRowIssueSchema>;
export const receivingImportFailureSchema = z.object({
  error: z.string().min(1),
  rowErrors: z.array(receivingImportRowIssueSchema).optional(),
});
export const receivingImportResultSchema = z.object({
  success: z.literal(true),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});
