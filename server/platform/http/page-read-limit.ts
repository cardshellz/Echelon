import type { NextFunction, Request, RequestHandler, Response } from "express";

// A conservative per-web-process ceiling for heavy page reads. Several reads
// use more than one connection, so this reduces pressure on the default 20-slot
// pool; it does not reserve connections or guarantee that any single read fits.
export const MAX_CONCURRENT_PAGE_READS = 4;
export const PAGE_READ_RETRY_SECONDS = 1;
type PageReadHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** One limiter is shared across participating page endpoints, not per user or
 * route. No waiting queue: surplus requests get a small, retryable 503 before
 * database work starts. Never release on browser disconnect while work continues.
 */
export function createPageReadLimiter(maxConcurrent: number = MAX_CONCURRENT_PAGE_READS) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError("Page read concurrency must be a positive safe integer");
  }
  let active = 0;
  return (handler: PageReadHandler): RequestHandler => async (req, res, next) => {
    if (req.aborted || res.destroyed) return;
    if (active >= maxConcurrent) {
      res.setHeader("Retry-After", String(PAGE_READ_RETRY_SECONDS));
      res.setHeader("Cache-Control", "no-store");
      res.status(503).json({
        code: "PAGE_READ_BUSY",
        error: "The server is busy loading pages. Please retry in a moment.",
      });
      return;
    }
    active++;
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    } finally {
      active--;
    }
  };
}

// Process-local on purpose: separate web dynos have separate memory budgets.
export const limitPageRead = createPageReadLimiter();

/** Promise.all rejects before its other SQL reads settle. Draining the bounded
 * read group keeps its admission slot occupied even when one query fails early.
 * These are read groups only, not a substitute for transactional writes.
 */
export async function awaitPageReads<const T extends readonly unknown[]>(
  reads: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const outcomes = await Promise.allSettled(reads);
  const values = outcomes.map(outcome => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
  // allSettled preserves the input order; every entry is checked above.
  return values as { -readonly [K in keyof T]: Awaited<T[K]> };
}
