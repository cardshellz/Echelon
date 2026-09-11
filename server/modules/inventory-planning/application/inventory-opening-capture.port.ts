import type { OpeningCaptureStatus } from "@shared/types/inventory-opening-capture";

export interface InventoryOpeningCapturePort {
  enqueue(actor: string, requestKey: string): Promise<OpeningCaptureStatus>;
  status(actor: string, id: string): Promise<OpeningCaptureStatus>;
  chunk(actor: string, id: string, index: number): Promise<{ captureId: string; index: number; text: string }>;
}
