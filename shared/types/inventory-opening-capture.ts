import { z } from "zod";

export const OPENING_CAPTURE_CHUNK_CHARACTERS = 32_768;
export const OPENING_CAPTURE_MAX_CHUNKS = 2_048;
export const openingCaptureRequestSchema = z.object({ idempotencyKey: z.string().uuid() }).strict();
export const openingCaptureIdSchema = z.string().uuid();
export const openingCaptureStageSchema = z.enum([
  "queued", "starting", "transaction_guard", "inventory_custody", "wms_demand_and_packages",
  "variant_identity", "original_costs", "oms_demand_and_receipts", "shipment_reviews",
  "evidence_validation", "writing_result", "complete", "failed",
]);
export const openingCaptureStatusSchema = z.object({
  id: openingCaptureIdSchema,
  state: z.enum(["queued", "running", "complete", "failed"]),
  stage: openingCaptureStageSchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  chunkCount: z.number().int().min(0).max(OPENING_CAPTURE_MAX_CHUNKS),
  errorCode: z.string().max(100).nullable(),
}).strict();
export type OpeningCaptureStatus = z.infer<typeof openingCaptureStatusSchema>;
export const openingCaptureChunkSchema = z.object({
  captureId: openingCaptureIdSchema,
  index: z.number().int().min(0).max(OPENING_CAPTURE_MAX_CHUNKS - 1),
  text: z.string().max(OPENING_CAPTURE_CHUNK_CHARACTERS),
}).strict();
