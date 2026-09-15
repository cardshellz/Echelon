import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Radio } from "lucide-react";
import {
  INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH,
  inventoryRuntimeAuthorityReadoutSchema,
  type InventoryRuntimeAuthorityReadout,
} from "@shared/types/inventory-runtime-authority";
import { Badge } from "@/components/ui/badge";

export interface InventoryRuntimeAuthorityDescription {
  /** Short badge text naming the allocator whose output providers receive. */
  label: string;
  /** Provenance for the tooltip: authority, revision, actor, time and reason. */
  detail: string;
}

const ALLOCATOR_LABELS: Record<InventoryRuntimeAuthorityReadout["liveAllocator"], string> = {
  channel_allocation_rules: "Channel Allocation rules",
  inventory_exposure: "Channel Inventory",
};

/** Pure presentation rule shared by both operator pages; it never infers a state the server did not report. */
export function describeInventoryRuntimeAuthority(
  readout: InventoryRuntimeAuthorityReadout,
): InventoryRuntimeAuthorityDescription {
  return {
    label: `Live allocator: ${ALLOCATOR_LABELS[readout.liveAllocator]}`,
    detail: `${readout.authority} authority, revision ${readout.revision}, set by ${readout.changedBy}`
      + ` at ${readout.changedAt}: ${readout.changeReason}`,
  };
}

async function readInventoryRuntimeAuthority(): Promise<InventoryRuntimeAuthorityReadout> {
  const response = await fetch(INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH, { credentials: "include" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      && body.error && typeof body.error === "object" && "message" in body.error
      && typeof body.error.message === "string"
      ? body.error.message
      : `${response.status}: the live allocator could not be read.`;
    throw new Error(message);
  }
  return inventoryRuntimeAuthorityReadoutSchema.parse(body);
}

export function useInventoryRuntimeAuthority() {
  return useQuery<InventoryRuntimeAuthorityReadout, Error>({
    queryKey: [INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH],
    queryFn: readInventoryRuntimeAuthority,
  });
}

/**
 * Shows which allocator currently publishes channel quantities. While the
 * read is pending or failed it says so explicitly; it never defaults to
 * "legacy", because that is exactly the assumption cutover invalidates.
 */
export function InventoryRuntimeAuthorityBadge({ className }: { className?: string }) {
  const query = useInventoryRuntimeAuthority();
  if (query.isLoading) {
    return <Badge variant="outline" className={className} aria-busy="true">Reading live allocator…</Badge>;
  }
  if (query.error || !query.data) {
    return (
      <Badge variant="destructive" className={className} role="alert" title={query.error?.message}>
        <AlertTriangle className="mr-1 h-3.5 w-3.5" />Live allocator unknown
      </Badge>
    );
  }
  const description = describeInventoryRuntimeAuthority(query.data);
  return (
    <Badge
      variant={query.data.authority === "canonical" ? "default" : "secondary"}
      className={className}
      title={description.detail}
      data-authority={query.data.authority}
    >
      <Radio className="mr-1 h-3.5 w-3.5" />{description.label}
    </Badge>
  );
}
