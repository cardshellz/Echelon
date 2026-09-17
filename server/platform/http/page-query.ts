import { z } from "zod";

const MAX_DATABASE_INTEGER = 2_147_483_647;
export const MAX_HISTORY_PAGE_SIZE = 200;
const queryInteger = (minimum: number, maximum: number, fallback: number) => z.union([
  z.string().regex(/^\d+$/).transform(Number), z.number(),
]).pipe(z.number().int().min(minimum).max(maximum)).default(fallback);

export const offsetPageQuerySchema = z.object({
  limit: queryInteger(1, MAX_HISTORY_PAGE_SIZE, 50),
  offset: queryInteger(0, MAX_DATABASE_INTEGER, 0),
});

export const numberedPageQuerySchema = z.object({
  limit: queryInteger(1, MAX_HISTORY_PAGE_SIZE, 50),
  page: queryInteger(1, MAX_DATABASE_INTEGER, 1),
}).refine(input => (input.page - 1) * input.limit <= MAX_DATABASE_INTEGER, {
  path: ["page"], message: "Page offset exceeds the supported range",
});
