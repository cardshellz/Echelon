import { Request, Response } from "express";
import { OrderOrchestrator, AgentOrderPayload } from "../../application/orderOrchestrator";
import { DropshipError } from "../../domain/errors";

export class AgentController {
  
  /**
   * System-level ingress dynamically mapped to receive Multi-Channel Webhook hits securely.
   * Transmits explicitly bound validations handling exceptions synchronously without disrupting inbound API pipelines.
   */
  static async ingestOrderRoute(req: Request, res: Response) {
    try {
      // Middleware resolution limits
      const vendorId = req.vendor!.id;
      const tier = req.vendor!.tier;
      
      const payload: AgentOrderPayload = req.body;

      // Ensure minimal architectural payload properties
      if (!payload.remoteOrderId || !payload.items || payload.items.length === 0 || !payload.platform) {
        return res.status(400).json({ error: true, code: "INVALID_DTO", message: "Payload lacks critical execution bounds natively required." });
      }

      // Route through explicitly configured ACID boundaries seamlessly
      await OrderOrchestrator.ingestOrder(vendorId, tier, payload);

      return res.status(202).json({
        success: true,
        message: "Dropship mappings established deterministically."
      });

    } catch (error: any) {
      if (error instanceof DropshipError) {
        const statusCode = error.code === 'INSUFFICIENT_FUNDS' ? 402 : 400;
        return res.status(statusCode).json(error.toJSON());
      }
      
      console.error("[AgentController] Disastrous resolution collapse:", error);
      return res.status(500).json({
        error: true,
        code: "INTERNAL_ERROR",
        message: "Financial locks prevented secure execution."
      });
    }
  }
}
