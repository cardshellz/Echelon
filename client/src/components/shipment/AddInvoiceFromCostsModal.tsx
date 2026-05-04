import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

import { format } from "date-fns";
import { ArrowLeft, Loader2 } from "lucide-react";

interface CostVendor {
  vendorId: number;
  vendorName: string;
  unbilledCostCount: number;
  unbilledTotalCents: number;
}

interface CostRow {
  id: number;
  costType: string;
  description: string | null;
  performedByName: string | null;
  actualCents: number | null;
  estimatedCents: number | null;
}

interface LineState {
  costId: number;
  costType: string;
  description: string;
  costAmountCents: number;
  invoiceAmountCents: number;
  included: boolean;
}

interface AddInvoiceFromCostsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipmentId: number;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function AddInvoiceFromCostsModal({
  open,
  onOpenChange,
  shipmentId,
}: AddInvoiceFromCostsModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<"vendor" | "invoice">("vendor");
  const [selectedVendor, setSelectedVendor] = useState<CostVendor | null>(null);

  // Invoice form state
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineState[]>([]);

  // Step 1: Fetch vendors with unbilled costs
  const { data: vendorsData, isLoading: vendorsLoading } = useQuery<{
    vendors: CostVendor[];
  }>({
    queryKey: [`/api/inbound-shipments/${shipmentId}/cost-vendors`],
    enabled: open && step === "vendor",
  });

  // Step 2: Fetch cost rows for selected vendor
  const { data: costsData, isLoading: costsLoading } = useQuery<{ costs: CostRow[] }>({
    queryKey: [`/api/inbound-shipments/${shipmentId}/cost-vendors/${selectedVendor?.vendorId}/costs`],
    enabled: open && step === "invoice" && !!selectedVendor,
  });

  // Initialize lines when costs load
  const costsInitialized = useMemo(() => {
    if (costsData?.costs && lines.length === 0) {
      const initialLines: LineState[] = costsData.costs.map((c) => {
        const amount = c.actualCents ?? c.estimatedCents ?? 0;
        const label = c.costType.replace(/_/g, " ");
        const desc = c.description || `${label}: ${c.performedByName || selectedVendor?.vendorName || ""}`;
        return {
          costId: c.id,
          costType: label,
          description: desc,
          costAmountCents: amount,
          invoiceAmountCents: amount,
          included: true,
        };
      });
      setLines(initialLines);
      return true;
    }
    return lines.length > 0;
  }, [costsData, lines.length, selectedVendor]);

  // Create invoice mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const includedLines = lines.filter((l) => l.included);
      const costRowIds = includedLines.map((l) => l.costId);
      const lineOverrides = includedLines
        .filter((l) => l.invoiceAmountCents !== l.costAmountCents)
        .map((l) => ({
          freightCostId: l.costId,
          qtyInvoiced: 1,
          unitCostCents: l.invoiceAmountCents,
          description: l.description,
        }));

      const payload = {
        vendorId: selectedVendor!.vendorId,
        invoiceNumber: invoiceNumber.trim(),
        invoiceDate: new Date(invoiceDate + "T00:00:00").toISOString(),
        dueDate: dueDate ? new Date(dueDate + "T00:00:00").toISOString() : undefined,
        costRowIds,
        lineOverrides: lineOverrides.length > 0 ? lineOverrides : undefined,
        notes: notes.trim() || undefined,
      };

      const res = await apiRequest(
        "POST",
        `/api/inbound-shipments/${shipmentId}/create-invoice`,
        payload,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/inbound-shipments/${shipmentId}`],
      });
      queryClient.invalidateQueries({
        queryKey: [`/api/inbound-shipments/${shipmentId}/invoices`],
      });
      queryClient.invalidateQueries({
        queryKey: [`/api/inbound-shipments/${shipmentId}/cost-vendors`],
      });
      toast({ title: "Invoice created" });
      handleClose();
    },
    onError: (err: Error) => {
      toast({
        title: "Error creating invoice",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleClose = () => {
    setStep("vendor");
    setSelectedVendor(null);
    setInvoiceNumber("");
    setInvoiceDate(format(new Date(), "yyyy-MM-dd"));
    setDueDate("");
    setNotes("");
    setLines([]);
    onOpenChange(false);
  };

  const handleSelectVendor = (vendor: CostVendor) => {
    setSelectedVendor(vendor);
    setStep("invoice");
    setLines([]);
  };

  const handleToggleLine = (costId: number, included: boolean) => {
    setLines((prev) =>
      prev.map((l) => (l.costId === costId ? { ...l, included } : l)),
    );
  };

  const handleAmountChange = (costId: number, amountStr: string) => {
    const cents = Math.round(parseFloat(amountStr || "0") * 100) || 0;
    setLines((prev) =>
      prev.map((l) => (l.costId === costId ? { ...l, invoiceAmountCents: cents } : l)),
    );
  };

  const totalCents = lines
    .filter((l) => l.included)
    .reduce((sum, l) => sum + l.invoiceAmountCents, 0);

  const canSubmit =
    invoiceNumber.trim().length > 0 &&
    invoiceDate.length > 0 &&
    lines.some((l) => l.included) &&
    !createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        {step === "vendor" && (
          <>
            <DialogHeader>
              <DialogTitle>Add Invoice</DialogTitle>
              <DialogDescription>
                Select a vendor with unbilled cost rows on this shipment.
              </DialogDescription>
            </DialogHeader>

            {vendorsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !vendorsData?.vendors?.length ? (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">
                  All cost rows for this shipment are either invoiced or have no
                  vendor assigned.
                </p>
                <p className="text-xs mt-1">
                  Set vendors on cost rows in the Costs tab first.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {vendorsData.vendors.map((v) => (
                  <button
                    key={v.vendorId}
                    onClick={() => handleSelectVendor(v)}
                    className="w-full flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left"
                  >
                    <div>
                      <div className="font-medium">{v.vendorName}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {v.unbilledCostCount} unbilled cost
                        {v.unbilledCostCount !== 1 ? "s" : ""}
                      </Badge>
                      <span className="font-mono text-sm font-medium">
                        {formatCents(v.unbilledTotalCents)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {step === "invoice" && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStep("vendor");
                    setSelectedVendor(null);
                    setLines([]);
                  }}
                  className="p-1 h-auto"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                  <DialogTitle>
                    Create Invoice — {selectedVendor?.vendorName}
                  </DialogTitle>
                  <DialogDescription>
                    Review and edit invoice lines from unbilled cost rows.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {costsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4">
                {/* Invoice header fields */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Invoice Number *</Label>
                    <Input
                      value={invoiceNumber}
                      onChange={(e) => setInvoiceNumber(e.target.value)}
                      placeholder="Vendor's invoice number"
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Invoice Date *</Label>
                    <Input
                      type="date"
                      value={invoiceDate}
                      onChange={(e) => setInvoiceDate(e.target.value)}
                      className="h-10"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Due Date</Label>
                    <Input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Notes</Label>
                    <Textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Optional notes"
                      rows={1}
                      className="h-10 min-h-[40px]"
                    />
                  </div>
                </div>

                {/* Lines preview table */}
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10"></TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                        <TableHead className="text-right">Invoice</TableHead>
                        <TableHead className="text-right">Variance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={6}
                            className="text-center text-muted-foreground py-4"
                          >
                            No cost rows found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        lines.map((line) => {
                          const variance =
                            line.costAmountCents - line.invoiceAmountCents;
                          return (
                            <TableRow
                              key={line.costId}
                              className={
                                !line.included ? "opacity-40" : ""
                              }
                            >
                              <TableCell>
                                <Checkbox
                                  checked={line.included}
                                  onCheckedChange={(checked) =>
                                    handleToggleLine(line.costId, !!checked)
                                  }
                                />
                              </TableCell>
                              <TableCell className="text-xs capitalize">
                                {line.costType}
                              </TableCell>
                              <TableCell className="text-sm max-w-[200px] truncate">
                                {line.description}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {formatCents(line.costAmountCents)}
                              </TableCell>
                              <TableCell className="text-right">
                                <Input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={(line.invoiceAmountCents / 100).toFixed(2)}
                                  onChange={(e) =>
                                    handleAmountChange(line.costId, e.target.value)
                                  }
                                  disabled={!line.included}
                                  className="h-8 w-24 text-right font-mono text-sm ml-auto"
                                />
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {variance !== 0 && (
                                  <span
                                    className={
                                      variance > 0
                                        ? "text-green-600"
                                        : "text-red-600"
                                    }
                                  >
                                    {variance > 0 ? "+" : ""}
                                    {formatCents(variance)}
                                  </span>
                                )}
                                {variance === 0 && (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Total */}
                <div className="flex justify-between items-center px-1">
                  <span className="text-sm font-medium">
                    Total ({lines.filter((l) => l.included).length} line
                    {lines.filter((l) => l.included).length !== 1 ? "s" : ""})
                  </span>
                  <span className="font-mono text-lg font-bold">
                    {formatCents(totalCents)}
                  </span>
                </div>

                {/* Actions */}
                <div className="flex gap-2 justify-end pt-2">
                  <Button variant="outline" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => createMutation.mutate()}
                    disabled={!canSubmit}
                  >
                    {createMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      "Create Invoice"
                    )}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
