import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { US_POSTAL_REGIONS } from "../rate-table-model";
import {
  assignmentLabel,
  postJson,
  type ManualRateQuoteResponse,
  type ProgramOverview,
  type RateBookAssignment,
  type WarehouseOption,
} from "./api";

interface RateTestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  program: ProgramOverview;
  warehouses: WarehouseOption[];
}

interface RateTestPayload {
  expectedRateBookId: number;
  pricingChannel: string;
  ratePurpose: string;
  originWarehouseId: number;
  destination: {
    country: "US";
    region: string;
    postalCode: string;
  };
  billableWeightGrams: number;
}

export function RateTestDialog({
  open,
  onOpenChange,
  program,
  warehouses,
}: RateTestDialogProps) {
  const assignments = program.activeAssignments;
  const [assignmentId, setAssignmentId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [region, setRegion] = useState("PA");
  const [postalCode, setPostalCode] = useState("");
  const [weightPounds, setWeightPounds] = useState("1");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualRateQuoteResponse | null>(null);
  const initialAssignment = assignments[0] ?? null;
  const resetAssignmentId = initialAssignment ? String(initialAssignment.id) : "";
  const resetWarehouseId = initialWarehouseId(initialAssignment, warehouses);

  const selectedAssignment = useMemo(
    () => assignments.find((assignment) => String(assignment.id) === assignmentId) ?? null,
    [assignmentId, assignments],
  );

  useEffect(() => {
    if (!open) return;
    setAssignmentId(resetAssignmentId);
    setWarehouseId(resetWarehouseId);
    setRegion("PA");
    setPostalCode("");
    setWeightPounds("1");
    setValidationError(null);
    setResult(null);
  }, [open, program.book.id, resetAssignmentId, resetWarehouseId]);

  const quoteMutation = useMutation({
    mutationFn: (payload: RateTestPayload) => postJson<ManualRateQuoteResponse>(
      "/api/shipping/admin/rate-quotes/test",
      payload,
    ),
    onSuccess: (response) => {
      setResult(response);
      setValidationError(null);
    },
    onError: (error: Error) => {
      setResult(null);
      setValidationError(error.message);
    },
  });

  const runTest = () => {
    if (selectedAssignment === null) {
      setValidationError("Assign this program to a pricing flow before testing it.");
      return;
    }
    const parsedWarehouseId = Number(warehouseId);
    if (!Number.isSafeInteger(parsedWarehouseId) || parsedWarehouseId <= 0) {
      setValidationError("Choose an active origin warehouse.");
      return;
    }
    if (!/^\d{5}$/.test(postalCode.trim())) {
      setValidationError("Enter a five-digit United States ZIP code.");
      return;
    }
    const numericWeight = Number(weightPounds);
    if (!Number.isFinite(numericWeight) || numericWeight <= 0) {
      setValidationError("Shipment weight must be greater than zero.");
      return;
    }
    const billableWeightGrams = Math.ceil(numericWeight * 453.59237);
    setValidationError(null);
    quoteMutation.mutate({
      expectedRateBookId: program.book.id,
      pricingChannel: selectedAssignment.pricingChannel,
      ratePurpose: selectedAssignment.ratePurpose,
      originWarehouseId: parsedWarehouseId,
      destination: {
        country: "US",
        region,
        postalCode: postalCode.trim(),
      },
      billableWeightGrams,
    });
  };

  const warehouseLocked = selectedAssignment?.originWarehouseId !== null
    && selectedAssignment?.originWarehouseId !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Test live US rates</DialogTitle>
          <DialogDescription>
            Run the active production assignment for one warehouse, destination, and shipment weight.
            The result is saved in quote history as a manual test.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rate-test-flow">Pricing flow</Label>
            <Select
              value={assignmentId}
              onValueChange={(value) => {
                const assignment = assignments.find((item) => String(item.id) === value) ?? null;
                setAssignmentId(value);
                setWarehouseId(initialWarehouseId(assignment, warehouses));
                setResult(null);
              }}
            >
              <SelectTrigger id="rate-test-flow"><SelectValue placeholder="Choose a pricing flow" /></SelectTrigger>
              <SelectContent>
                {assignments.map((assignment) => (
                  <SelectItem key={assignment.id} value={String(assignment.id)}>
                    {assignmentLabel(assignment)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rate-test-warehouse">Origin warehouse</Label>
            <Select
              value={warehouseId}
              disabled={warehouseLocked}
              onValueChange={(value) => {
                setWarehouseId(value);
                setResult(null);
              }}
            >
              <SelectTrigger id="rate-test-warehouse"><SelectValue placeholder="Choose a warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                    {warehouse.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rate-test-region">Destination state</Label>
            <Select value={region} onValueChange={(value) => {
              setRegion(value);
              setResult(null);
            }}>
              <SelectTrigger id="rate-test-region"><SelectValue /></SelectTrigger>
              <SelectContent>
                {US_POSTAL_REGIONS.map(([code, name]) => (
                  <SelectItem key={code} value={code}>{name} ({code})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rate-test-postal">Destination ZIP</Label>
            <Input
              id="rate-test-postal"
              inputMode="numeric"
              maxLength={5}
              value={postalCode}
              onChange={(event) => {
                setPostalCode(event.target.value.replace(/\D/g, "").slice(0, 5));
                setResult(null);
              }}
              placeholder="16066"
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2 sm:max-w-[calc(50%-0.5rem)]">
            <Label htmlFor="rate-test-weight">Shipment weight (lb)</Label>
            <Input
              id="rate-test-weight"
              inputMode="decimal"
              value={weightPounds}
              onChange={(event) => {
                setWeightPounds(event.target.value);
                setResult(null);
              }}
              placeholder="1.00"
            />
          </div>
        </div>

        {validationError && (
          <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{validationError}</span>
          </div>
        )}

        {result && <RateTestResult result={result} />}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            onClick={runTest}
            disabled={quoteMutation.isPending || assignments.length === 0 || warehouses.length === 0}
          >
            {quoteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Test rate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RateTestResult({ result }: { result: ManualRateQuoteResponse }) {
  const quoted = result.outcome === "quoted";
  return (
    <div className={quoted
      ? "rounded-md border border-emerald-300 bg-emerald-50/60 p-3"
      : "rounded-md border border-amber-300 bg-amber-50/60 p-3"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {quoted
            ? <CheckCircle2 className="h-4 w-4 text-emerald-700" />
            : <AlertTriangle className="h-4 w-4 text-amber-700" />}
          <span className="text-sm font-medium">
            {result.outcome === "quoted"
              ? "Live rate found"
              : result.outcome === "rate_book_mismatch"
                ? "A different program owns this route"
                : "No live rate found"}
          </span>
        </div>
        <Badge variant="outline">
          {result.destination.region} {result.destination.postalCode}
        </Badge>
      </div>

      {result.quotes.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-md border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shipping option</TableHead>
                <TableHead>Promise</TableHead>
                <TableHead>Calculation</TableHead>
                <TableHead className="text-right">Customer charge</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.quotes.map((quote) => (
                <TableRow key={quote.serviceLevelId}>
                  <TableCell className="font-medium">{quote.displayName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatPromise(quote.promiseMinBusinessDays, quote.promiseMaxBusinessDays)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {quote.chargeModel === "base_plus_per_started_pound"
                      ? `Base ${formatCurrencyFromCents(
                          quote.totalCents - (quote.perStartedPoundCents ?? 0) * (quote.billablePounds ?? 0),
                          quote.currency,
                        )} + ${formatCurrencyFromCents(quote.perStartedPoundCents ?? 0, quote.currency)} × ${quote.billablePounds ?? 0} started lb`
                      : "Fixed weight band"}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCurrencyFromCents(quote.totalCents, quote.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {result.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-amber-900">
          {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
    </div>
  );
}

function initialWarehouseId(
  assignment: RateBookAssignment | null,
  warehouses: WarehouseOption[],
): string {
  if (assignment?.originWarehouseId !== null && assignment?.originWarehouseId !== undefined) {
    return String(assignment.originWarehouseId);
  }
  return warehouses[0] ? String(warehouses[0].id) : "";
}

function formatPromise(minimum: number | null, maximum: number | null): string {
  if (minimum === null || maximum === null) return "Not set";
  return minimum === maximum
    ? `${minimum} business day${minimum === 1 ? "" : "s"}`
    : `${minimum}-${maximum} business days`;
}

function formatCurrencyFromCents(cents: number, currency: string): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${currency.toUpperCase()} ${whole}.${fraction}`;
}
