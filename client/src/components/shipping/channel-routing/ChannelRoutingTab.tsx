import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2, RefreshCw, Search, Settings2 } from "lucide-react";
import type {
  ShippingChannelPolicyPurpose,
  ShippingChannelPolicySlotSummary,
  ShippingChannelRoutingChannelSummary,
} from "@shared/types/shipping-channel-routing";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CHANNEL_ROUTING_KEY,
  loadChannelRouting,
} from "./api";
import { PolicyEditorDialog } from "./PolicyEditorDialog";

interface EditorSelection {
  channel: ShippingChannelRoutingChannelSummary;
  purpose: ShippingChannelPolicyPurpose;
}

export function ChannelRoutingTab() {
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<EditorSelection | null>(null);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [CHANNEL_ROUTING_KEY],
    queryFn: loadChannelRouting,
  });

  const channels = useMemo(() => {
    const text = search.trim().toLowerCase();
    if (!data || text === "") return data?.channels ?? [];
    return data.channels.filter((channel) =>
      channel.name.toLowerCase().includes(text)
      || channel.provider.toLowerCase().includes(text)
      || String(channel.id).includes(text));
  }, [data, search]);

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading channel routing
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 border">
        <CircleAlert className="h-5 w-5 text-destructive" />
        <p className="text-sm font-medium">Channel routing could not be loaded.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <Alert>
          <CircleAlert className="h-4 w-4" />
          <AlertTitle>Configuration and shadow testing only</AlertTitle>
          <AlertDescription>
              Quote traffic still uses existing channel routing until a later,
              separately controlled cutover.
          </AlertDescription>
        </Alert>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Channel routing</h2>
            <p className="text-sm text-muted-foreground">
                Rate ownership and destination eligibility by channel.
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search channels"
              className="pl-9"
            />
          </div>
        </div>

        <div className="overflow-x-auto border">
          <Table className="min-w-[56rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Customer checkout</TableHead>
                  <TableHead>Vendor fulfillment charge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-28 text-center text-muted-foreground">
                      No channels match the current search.
                    </TableCell>
                  </TableRow>
                ) : channels.map((channel) => (
                  <TableRow key={channel.id}>
                    <TableCell>
                      <div className="font-medium">{channel.name}</div>
                      <div className="text-xs text-muted-foreground">Channel {channel.id}</div>
                    </TableCell>
                    <TableCell>
                      <div className="capitalize">{channel.provider}</div>
                      {channel.shippingCapabilities === null && (
                        <div className="mt-1 text-xs font-medium text-destructive">
                          No shipping adapter
                        </div>
                      )}
                      <Badge
                        variant={channel.status === "active" ? "outline" : "secondary"}
                        className="mt-1 capitalize"
                      >
                        {channel.status.replaceAll("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <PolicySlot
                        slot={channel.customerCheckout}
                        onOpen={() => setEditor({
                          channel,
                          purpose: "customer_checkout",
                        })}
                      />
                    </TableCell>
                    <TableCell>
                      <PolicySlot
                        slot={channel.vendorFulfillmentCharge}
                        onOpen={() => setEditor({
                          channel,
                          purpose: "vendor_fulfillment_charge",
                        })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
          </Table>
        </div>
      </div>

      {editor && (
        <PolicyEditorDialog
          open
          channel={editor.channel}
          purpose={editor.purpose}
          destinationScopes={data.destinationScopes}
          rateBooks={data.rateBooks}
          warehouses={data.warehouses}
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
        />
      )}
    </>
  );
}

function PolicySlot({
  slot,
  onOpen,
}: {
  slot: ShippingChannelPolicySlotSummary;
  onOpen: () => void;
}) {
  return (
    <div className="flex min-w-44 items-center justify-between gap-3">
      <div className="space-y-1">
        {slot.draft ? (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Draft v{slot.draft.version}</Badge>
            {slot.active && (
              <span className="text-xs text-muted-foreground">
                Active v{slot.active.version}
              </span>
            )}
          </div>
        ) : slot.active ? (
          <Badge variant="outline">Active v{slot.active.version}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">No policy</span>
        )}
      </div>
      <Button
        variant="outline"
        size="icon"
        title="Configure channel routing"
        onClick={onOpen}
      >
        <Settings2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
