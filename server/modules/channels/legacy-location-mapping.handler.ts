import type { Request, Response } from "express";

/** Kept as a tombstone for stale clients; never rewrites global warehouse data. */
export function rejectLegacyLocationMapping(_request: Request, response: Response): void {
  response.status(410).json({
    code: "LEGACY_SHOPIFY_LOCATION_MAPPING_RETIRED",
    error: "Manage inventory warehouse sources and destinations in Channel Inventory. No connection or warehouse mapping was changed.",
    replacementPath: "/channels/inventory",
  });
}
