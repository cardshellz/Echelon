import { z } from "zod";

const queryInteger = z.union([z.number(),z.string().regex(/^(0|[1-9]\d*)$/).transform(Number)]).pipe(z.number().int().safe().nonnegative());
export const lotCostFollowUpQuerySchema = z.object({
  afterId: queryInteger.default(0),
  limit: queryInteger.pipe(z.number().min(1).max(200)).default(50),
}).strict();
export const lotCostFollowUpReportSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().safe().positive(),inventoryLotId: z.number().int().positive(),relatedLotId: z.number().int().positive().nullable(),
    operationKey: z.string().min(1),issueCode: z.string().min(1),evidence: z.record(z.unknown()),
    state: z.enum(["resolved","review_required","retry_required"]),applicationId: z.number().int().safe().positive().nullable(),
    recordedBy: z.string().min(1),recordedAt: z.string().datetime({ offset: true }),
  }).strict()).max(200),nextAfterId: z.number().int().safe().positive().nullable(),
}).strict();
