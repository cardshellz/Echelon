import { Request, Response } from "express";
import { CatalogOrchestrator } from "../../application/catalogOrchestrator";
import { VendorTier } from "../../domain/vendor";

export class CatalogController {
  
  /**
   * Pure HTTP Exit point transmitting strictly defined DTOs payload.
   * Architecture strictly protects Domain rules relying entirely upon Context mapped middleware.
   */
  static async fetchGrid(req: Request, res: Response) {
    try {
      // Identity middleware must append vendor execution context dynamically
      const tier = (req.vendor?.tier as VendorTier) || "standard";
      
      const grid = await CatalogOrchestrator.getVendorCatalog(tier);

      return res.status(200).json({
        success: true,
        count: grid.length,
        data: grid
      });

    } catch (error: any) {
      console.error("[CatalogController] Grid Synchronization Extinguished:", error);
      return res.status(500).json({
        error: true,
        code: "INTERNAL_CATALOG_ERROR",
        message: "A critical infrastructural constraint prevented the ledger grid from rendering."
      });
    }
  }
}
