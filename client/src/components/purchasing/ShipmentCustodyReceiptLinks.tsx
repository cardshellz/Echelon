import React from "react";
import { Link } from "wouter";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { shipmentCustodyReceiptIds, type ShipmentReceiveCoverage } from "@/lib/shipment-receipt-units";

/** Retained receipt IDs identify the custody owner; never guess from the PO. */
export function ShipmentCustodyReceiptLinks({ coverage }: { coverage: ShipmentReceiveCoverage }) {
  const navigation = useProcurementNavigation();
  const receiptIds = shipmentCustodyReceiptIds(coverage);
  if (!receiptIds.length) return null;
  return <div className="mt-2 flex flex-col items-start gap-1">
    {receiptIds.map(receiptId => <Link key={receiptId}
      href={navigation.childHref(`/receiving?open=${receiptId}`)}
      className="inline-flex min-h-9 items-center text-sm text-primary underline underline-offset-4">
      Review custody on receipt #{receiptId}
    </Link>)}
  </div>;
}
