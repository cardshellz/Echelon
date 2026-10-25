import type { RequestHandler } from "express";
import {
  assertEbayPolicyWriteOwned,
  EbayBusinessPolicyError,
} from "@shared/ebay-business-policies";

/** Catalog commands cannot bypass channel policy ownership or its permission checks. */
export function protectEbayPolicyWriteBoundary(
  operation: "create" | "update",
): RequestHandler {
  return (req, res, next) => {
    try {
      assertEbayPolicyWriteOwned(req.body, { operation });
      // Validate the entire create request before its first write. A rejected
      // nested variant must not leave an otherwise-created product behind.
      if (
        req.body &&
        typeof req.body === "object" &&
        Array.isArray(req.body.variants)
      ) {
        for (const variant of req.body.variants)
          assertEbayPolicyWriteOwned(variant, { operation });
      }
      next();
    } catch (error) {
      if (error instanceof EbayBusinessPolicyError) {
        res
          .status(error.statusCode)
          .json({
            error: error.message,
            code: error.code,
            context: error.context,
          });
        return;
      }
      next(error);
    }
  };
}
