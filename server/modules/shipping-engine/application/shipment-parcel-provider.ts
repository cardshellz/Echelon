import type {
  ShipmentLineInput,
  ShipmentParcelPlan,
  ShipmentParcelPlanResult,
} from "../domain/shipment";

export interface ShipmentParcelProvider {
  readonly provider: ShipmentParcelPlan["provider"];
  plan(lines: readonly ShipmentLineInput[]): Promise<ShipmentParcelPlanResult>;
}
