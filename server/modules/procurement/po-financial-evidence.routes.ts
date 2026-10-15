import type { Express } from "express";
import { z } from "zod";
import {
  poFinancialEvidenceIdSchema,
  poFinancialEvidenceSchema,
} from "@shared/procurement/po-financial-evidence";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { logger } from "../../platform/observability/logger";
import { PoFinancialEvidenceSourceError } from "./po-financial-evidence.repository";
import { createPoFinancialEvidenceService } from "./po-financial-evidence.service";

const pathIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(poFinancialEvidenceIdSchema);

export function registerPoFinancialEvidenceRoutes(
  app: Express,
  service = createPoFinancialEvidenceService(db),
): void {
  app.get(
    "/api/purchase-orders/:id/financial-evidence",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      const id = pathIdSchema.safeParse(req.params.id);
      if (!id.success) {
        return res
          .status(400)
          .json({
            error: "Purchase order ID is invalid.",
            code: "PO_FINANCIAL_EVIDENCE_ID_INVALID",
          });
      }
      try {
        const evidence = await service.read(id.data);
        if (evidence === null)
          return res
            .status(404)
            .json({ error: "Purchase order not found.", code: "PO_NOT_FOUND" });
        return res.json(poFinancialEvidenceSchema.parse(evidence));
      } catch (error) {
        const code =
          error instanceof PoFinancialEvidenceSourceError
            ? error.code
            : "PO_FINANCIAL_EVIDENCE_UNAVAILABLE";
        logger.error("procurement.po_financial_evidence", {
          outcome: "failed",
          purchase_order_id: id.data,
          actor_id: req.session?.user?.id,
          error_code: code,
          error_class: error instanceof Error ? error.name : "UnknownError",
        });
        return res
          .status(503)
          .json({
            code,
            error:
              error instanceof PoFinancialEvidenceSourceError
                ? error.message
                : "Could not load purchase order financial evidence. Retry the read; no financial records were changed.",
          });
      }
    },
  );
}
