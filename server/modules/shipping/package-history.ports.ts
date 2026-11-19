import type {
  PackageHistoryDocument,
  PackageHistoryReadPort,
} from "@shared/shipping/package-history";
import type {
  PackageHistoryNative,
  PackageHistoryScope,
  RetainedPackageHistoryShipment,
} from "./package-history.domain";

export interface PackageHistoryClaim {
  omsOrderId: number;
  generation: string;
  leaseId: string;
  attempts: number;
}
export interface PackageHistoryFilter {
  channelId?: number;
  orderIds?: readonly number[];
}
export interface PackageHistorySource {
  scope(omsOrderId: number): Promise<PackageHistoryScope>;
  native(scope: PackageHistoryScope): Promise<PackageHistoryNative>;
  shipments(
    trackingNumber: string,
  ): Promise<readonly RetainedPackageHistoryShipment[]>;
}
export interface PackageHistoryStore extends PackageHistoryReadPort {
  drain(limit: number, filter?: PackageHistoryFilter): Promise<number>;
  claim(
    limit: number,
    now: Date,
    leaseId: string,
    filter?: PackageHistoryFilter,
  ): Promise<PackageHistoryClaim[]>;
  renew(claim: PackageHistoryClaim, now: Date): Promise<boolean>;
  complete(
    claim: PackageHistoryClaim,
    document: PackageHistoryDocument,
    now: Date,
  ): Promise<boolean>;
  fail(
    claim: PackageHistoryClaim,
    code: string,
    classification: "review" | "transient",
    now: Date,
  ): Promise<void>;
}
export interface PackageHistoryReport {
  action: "shipping_package_history";
  outcome: "published" | "superseded" | "retry" | "review";
  omsOrderId: number;
  code?: string;
}
