import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  FileSearch,
  Loader2,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  buildAdminDefaultReturnFeesUrl,
  buildAdminEffectiveReturnFeesUrl,
  buildAdminReturnInspectionInput,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  postJson,
  queryErrorMessage,
} from "@/lib/dropship-ops-surface";
import type {
  DropshipAdminEffectiveReturnFeesResponse,
  DropshipAdminReturnInspectionResponse,
  DropshipReturnDetail,
  DropshipReturnDetailResponse,
  DropshipReturnFaultCategory,
  DropshipReturnFeeScheduleRecord,
  DropshipReturnFeeType,
  DropshipRmaInspectionOutcome,
  DropshipRmaStatus,
} from "@/lib/dropship-ops-surface";

// ── Types ────────────────────────────────────────────────────────────────────

interface InspectionItemFormState {
  rmaItemId: number;
  productVariantId: number | null;
  quantity: number;
  status: string;
  finalCreditAmount: string;
  feeAmount: string;
}

interface InspectionFormState {
  rmaId: number;
  outcome: DropshipRmaInspectionOutcome;
  faultCategory: DropshipReturnFaultCategory;
  notes: string;
  items: InspectionItemFormState[];
}

/** One auditable RMA-level fee decision. */
interface FeeLine {
  feeType: DropshipReturnFeeType;
  label: string;
  defaultResponsibility: DropshipReturnFaultCategory;
  responsibility: DropshipReturnFaultCategory;
  policyFeeId: number;
  amountType: DropshipReturnFeeScheduleRecord["amountType"];
  policyAmount: number;
  proposedAmountCents: number;
  amount: string;
  overrideReason: string;
}

const RETURN_INSPECTION_ITEM_STATUSES = [
  "resellable",
  "warehouse_deals",
  "damaged_defective",
] as const;

const FAULT_CATEGORIES: DropshipReturnFaultCategory[] = [
  "card_shellz",
  "vendor",
  "customer",
  "carrier",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function centsToDollarInput(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "0.00";
  const dollars = Math.trunc(value / 100);
  const cents = value % 100;
  return `${dollars}.${String(cents).padStart(2, "0")}`;
}

function parseDollarInput(value: string): number | null {
  const normalized = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!normalized) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [dollars, cents = ""] = normalized.split(".");
  const result = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}

function buildFormState(rma: DropshipReturnDetail): InspectionFormState {
  return {
    rmaId: rma.rmaId,
    outcome: rma.status === "rejected" ? "rejected" : "approved",
    faultCategory: rma.faultCategory ?? "card_shellz",
    notes: rma.inspections[0]?.notes ?? "",
    items: rma.items.map((item) => {
      const creditCents =
        item.finalCreditCents ?? item.requestedCreditCents ?? 0;
      const feeCents = item.feeCents ?? 0;
      return {
        rmaItemId: item.rmaItemId,
        productVariantId: item.productVariantId,
        quantity: item.quantity,
        status:
          item.finalCreditCents !== null || item.feeCents !== null
            ? item.status
            : "resellable",
        finalCreditAmount: centsToDollarInput(creditCents),
        feeAmount: centsToDollarInput(feeCents),
      };
    }),
  };
}

function formTotals(form: InspectionFormState): {
  creditCents: number;
  feeCents: number;
  hasInvalidAmount: boolean;
} {
  return form.items.reduce<{
    creditCents: number;
    feeCents: number;
    hasInvalidAmount: boolean;
  }>(
    (acc, item) => {
      const credit = parseDollarInput(item.finalCreditAmount);
      const fee = parseDollarInput(item.feeAmount);
      return {
        creditCents: acc.creditCents + (credit ?? 0),
        feeCents: acc.feeCents + (fee ?? 0),
        hasInvalidAmount:
          acc.hasInvalidAmount || credit === null || fee === null,
      };
    },
    { creditCents: 0, feeCents: 0, hasInvalidAmount: false },
  );
}

function feeTypeLabel(feeType: string): string {
  switch (feeType) {
    case "restocking_fee":
      return "Restocking Fee";
    case "processing_fee":
      return "Processing Fee";
    case "return_shipping_fee":
      return "Return Shipping";
    default:
      return formatStatus(feeType);
  }
}

function feeRecordForType(
  fees: DropshipAdminEffectiveReturnFeesResponse["fees"],
  feeType: DropshipReturnFeeType,
): DropshipReturnFeeScheduleRecord | null {
  if (feeType === "restocking_fee") return fees.restockingFee;
  if (feeType === "processing_fee") return fees.processingFee;
  return fees.returnShippingFee;
}

function policyAmountCents(
  record: DropshipReturnFeeScheduleRecord,
  creditCents: number,
): number {
  if (record.amountType === "flat_cents") return record.amount;
  return Math.floor((creditCents * record.amount) / 100);
}

function buildFeeLines(
  defaults: DropshipAdminEffectiveReturnFeesResponse["fees"],
  responsibilityFees: Map<
    DropshipReturnFaultCategory,
    DropshipAdminEffectiveReturnFeesResponse["fees"]
  >,
  creditCents: number,
): FeeLine[] {
  const feeTypes: DropshipReturnFeeType[] = [
    "restocking_fee",
    "processing_fee",
    "return_shipping_fee",
  ];
  return feeTypes.flatMap((feeType) => {
    const defaultRecord = feeRecordForType(defaults, feeType);
    if (!defaultRecord) return [];
    const selectedRecord = feeRecordForType(
      responsibilityFees.get(defaultRecord.faultCategory) ?? defaults,
      feeType,
    );
    if (!selectedRecord) return [];
    const proposedAmountCents = policyAmountCents(selectedRecord, creditCents);
    return [
      {
        feeType,
        label: feeTypeLabel(feeType),
        defaultResponsibility: defaultRecord.faultCategory,
        responsibility: defaultRecord.faultCategory,
        policyFeeId: selectedRecord.feeId,
        amountType: selectedRecord.amountType,
        policyAmount: selectedRecord.amount,
        proposedAmountCents,
        amount: centsToDollarInput(proposedAmountCents),
        overrideReason: "",
      },
    ];
  });
}

function statusTone(status: DropshipRmaStatus): string {
  if (status === "credited" || status === "closed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (
    status === "approved" ||
    status === "received" ||
    status === "inspecting"
  ) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "rejected") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

// ── Component ────────────────────────────────────────────────────────────────

export function ReturnInspectionModal({
  rmaId,
  open,
  onOpenChange,
  onInspectionComplete,
}: {
  rmaId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInspectionComplete?: () => void;
}) {
  const [form, setForm] = useState<InspectionFormState | null>(null);
  const [feeLines, setFeeLines] = useState<FeeLine[]>([]);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  // Fetch RMA detail
  const rmaQuery = useQuery<DropshipReturnDetailResponse>({
    queryKey: ["dropship-admin-return-detail", rmaId],
    queryFn: () => {
      if (rmaId === null) throw new Error("Missing RMA ID.");
      return fetchJson<DropshipReturnDetailResponse>(
        `/api/dropship/admin/returns/${rmaId}`,
      );
    },
    enabled: rmaId !== null && open,
  });

  const rma = rmaQuery.data?.rma ?? null;

  // Initialize form when RMA loads
  useEffect(() => {
    if (!rma) return;
    setForm((current) => {
      if (current?.rmaId === rma.rmaId) return current;
      return buildFormState(rma);
    });
  }, [rma]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!open) {
      setForm(null);
      setFeeLines([]);
      setPending(false);
      setSubmitError(null);
      setSubmitSuccess(null);
    }
  }, [open]);

  const defaultsUrl = useMemo(
    () =>
      rma
        ? buildAdminDefaultReturnFeesUrl({
            vendorId: rma.vendorId,
            storeConnectionId: rma.storeConnectionId,
          })
        : null,
    [rma],
  );

  const defaultsQuery = useQuery<DropshipAdminEffectiveReturnFeesResponse>({
    queryKey: [defaultsUrl],
    queryFn: () => {
      if (!defaultsUrl) throw new Error("Missing default fee policy URL.");
      return fetchJson<DropshipAdminEffectiveReturnFeesResponse>(defaultsUrl);
    },
    enabled: defaultsUrl !== null && open,
  });

  const responsibilityQueries = useQueries({
    queries: FAULT_CATEGORIES.map((responsibility) => {
      const url = rma
        ? buildAdminEffectiveReturnFeesUrl({
            vendorId: rma.vendorId,
            storeConnectionId: rma.storeConnectionId,
            faultCategory: responsibility,
          })
        : null;
      return {
        queryKey: [url],
        queryFn: () => {
          if (!url) throw new Error("Missing responsibility fee policy URL.");
          return fetchJson<DropshipAdminEffectiveReturnFeesResponse>(url);
        },
        enabled: url !== null && open,
      };
    }),
  });
  const responsibilityData = FAULT_CATEGORIES.map(
    (_, index) => responsibilityQueries[index]?.data?.fees,
  );

  useEffect(() => {
    const defaults = defaultsQuery.data?.fees;
    if (!defaults || responsibilityData.some((fees) => !fees) || !form) return;
    const byResponsibility = new Map<
      DropshipReturnFaultCategory,
      DropshipAdminEffectiveReturnFeesResponse["fees"]
    >();
    FAULT_CATEGORIES.forEach((responsibility, index) => {
      const fees = responsibilityData[index];
      if (fees) byResponsibility.set(responsibility, fees);
    });
    setFeeLines((current) =>
      current.length > 0
        ? current
        : buildFeeLines(
            defaults,
            byResponsibility,
            formTotals(form).creditCents,
          ),
    );
  }, [defaultsQuery.data?.fees, form?.rmaId, ...responsibilityData]);

  const currentCreditCents = form ? formTotals(form).creditCents : 0;
  useEffect(() => {
    setFeeLines((current) =>
      current.map((line) => {
        if (line.amountType !== "percent") return line;
        const nextProposal = Math.floor(
          (currentCreditCents * line.policyAmount) / 100,
        );
        const enteredAmountCents = parseDollarInput(line.amount);
        return {
          ...line,
          proposedAmountCents: nextProposal,
          amount:
            enteredAmountCents === line.proposedAmountCents
              ? centsToDollarInput(nextProposal)
              : line.amount,
        };
      }),
    );
  }, [currentCreditCents]);

  if (!open) return null;

  const isLoading = rmaQuery.isLoading || rmaQuery.isFetching;
  const loadError = rmaQuery.error;
  const existingInspection = rma?.inspections[0] ?? null;
  const totals = form
    ? formTotals(form)
    : { creditCents: 0, feeCents: 0, hasInvalidAmount: false };

  const feePolicyLoading =
    defaultsQuery.isLoading ||
    responsibilityQueries.some((query) => query.isLoading);
  const feePolicyError =
    defaultsQuery.error ??
    responsibilityQueries.find((query) => query.error)?.error ??
    null;
  const feeLineTotals = feeLines.reduce(
    (acc, line) => {
      const amountCents = parseDollarInput(line.amount);
      const needsReason =
        line.responsibility !== line.defaultResponsibility ||
        amountCents !== line.proposedAmountCents;
      return {
        totalCents: acc.totalCents + (amountCents ?? 0),
        hasInvalid: acc.hasInvalid || amountCents === null,
        hasMissingReason:
          acc.hasMissingReason || (needsReason && !line.overrideReason.trim()),
      };
    },
    { totalCents: 0, hasInvalid: false, hasMissingReason: false },
  );
  const totalFeeCents = feeLineTotals.totalCents;
  const netCents = totals.creditCents - totalFeeCents;
  const hasInvalidFee = feeLineTotals.hasInvalid;
  const saveDisabled =
    pending ||
    existingInspection !== null ||
    totals.hasInvalidAmount ||
    form?.items.length === 0 ||
    hasInvalidFee ||
    feeLineTotals.hasMissingReason ||
    feePolicyLoading ||
    feePolicyError !== null ||
    feeLines.length !== 3;
  const rejectDisabled =
    pending || existingInspection !== null || totals.hasInvalidAmount;

  function updateForm(patch: Partial<InspectionFormState>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  function updateItem(
    rmaItemId: number,
    patch: Partial<
      Pick<
        InspectionItemFormState,
        "status" | "finalCreditAmount" | "feeAmount"
      >
    >,
  ) {
    setForm((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item) =>
          item.rmaItemId === rmaItemId ? { ...item, ...patch } : item,
        ),
      };
    });
  }

  function updateFeeResponsibility(
    feeType: DropshipReturnFeeType,
    responsibility: DropshipReturnFaultCategory,
  ) {
    const fees =
      responsibilityQueries[FAULT_CATEGORIES.indexOf(responsibility)]?.data
        ?.fees;
    const selectedRecord = fees ? feeRecordForType(fees, feeType) : null;
    if (!selectedRecord || !form) return;
    const proposedAmountCents = policyAmountCents(
      selectedRecord,
      formTotals(form).creditCents,
    );
    setFeeLines((current) =>
      current.map((line) =>
        line.feeType === feeType
          ? {
              ...line,
              responsibility,
              policyFeeId: selectedRecord.feeId,
              amountType: selectedRecord.amountType,
              policyAmount: selectedRecord.amount,
              proposedAmountCents,
              amount: centsToDollarInput(proposedAmountCents),
            }
          : line,
      ),
    );
  }

  function updateFeeAmount(feeType: DropshipReturnFeeType, amount: string) {
    setFeeLines((current) =>
      current.map((line) =>
        line.feeType === feeType ? { ...line, amount } : line,
      ),
    );
  }

  function updateFeeReason(
    feeType: DropshipReturnFeeType,
    overrideReason: string,
  ) {
    setFeeLines((current) =>
      current.map((line) =>
        line.feeType === feeType ? { ...line, overrideReason } : line,
      ),
    );
  }

  async function handleSave(outcome: DropshipRmaInspectionOutcome) {
    if (!form || !rma || rma.rmaId !== form.rmaId) return;
    setPending(true);
    setSubmitError(null);
    setSubmitSuccess(null);

    try {
      // Build per-item fee amounts from fee lines if available
      let items = form.items.map((item) => ({
        rmaItemId: item.rmaItemId,
        status: item.status,
        finalCreditAmount: item.finalCreditAmount,
        feeAmount: item.feeAmount,
      }));

      // Approved RMA-level fees are allocated across items for the existing item ledger contract.
      if (outcome === "approved" && feeLines.length > 0 && items.length > 0) {
        const totalFee = feeLineTotals.totalCents;
        const perItem = Math.floor(totalFee / items.length);
        const remainder = totalFee - perItem * items.length;
        items = items.map((item, index) => ({
          ...item,
          feeAmount: centsToDollarInput(
            perItem + (index === 0 ? remainder : 0),
          ),
        }));
      }

      const input = buildAdminReturnInspectionInput({
        idempotencyKey: createDropshipIdempotencyKey(
          `admin-return-inspection-${form.rmaId}`,
        ),
        outcome,
        faultCategory: form.faultCategory,
        notes: form.notes,
        items,
        feeDecisions:
          outcome === "approved"
            ? feeLines.map((line) => ({
                feeType: line.feeType,
                responsibility: line.responsibility,
                amount: line.amount,
                overrideReason: line.overrideReason,
              }))
            : undefined,
        returnShippingActualAmount:
          outcome === "approved"
            ? feeLines.find((line) => line.feeType === "return_shipping_fee")
                ?.amount
            : undefined,
      });

      const response = await postJson<DropshipAdminReturnInspectionResponse>(
        `/api/dropship/admin/returns/${form.rmaId}/inspection`,
        input,
      );

      setSubmitSuccess(
        `RMA ${response.rma.rmaNumber} ${formatStatus(response.inspection.outcome)}: ${formatCents(response.inspection.creditCents)} credit, ${formatCents(response.inspection.feeCents)} fee.`,
      );
      setForm(buildFormState(response.rma));
      onInspectionComplete?.();
    } catch (caught) {
      setSubmitError(
        caught instanceof Error ? caught.message : "Return inspection failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-w-3xl max-h-[90vh] overflow-y-auto",
          // Mobile: bottom sheet style
          "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:max-h-[95vh] max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:translate-y-0 max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=open]:slide-in-from-bottom",
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSearch className="h-5 w-5" />
            Inspect Return
          </DialogTitle>
          <DialogDescription>
            {rma
              ? `${rma.rmaNumber} · ${rma.vendorName || rma.vendorEmail || `Vendor ${rma.vendorId}`} · ${rma.platform ? formatStatus(rma.platform) : "No platform"}`
              : "Loading return details…"}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="space-y-3 py-4">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}

        {loadError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(
                loadError,
                "Unable to load RMA inspection detail.",
              )}
            </AlertDescription>
          </Alert>
        )}

        {submitError && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        {submitSuccess && (
          <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{submitSuccess}</AlertDescription>
          </Alert>
        )}

        {existingInspection && (
          <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>
              Inspection {existingInspection.rmaInspectionId} finalized as{" "}
              {formatStatus(existingInspection.outcome)} with{" "}
              {formatCents(existingInspection.creditCents)} credit and{" "}
              {formatCents(existingInspection.feeCents)} fee.
            </AlertDescription>
          </Alert>
        )}

        {rma && form && !isLoading && (
          <div className="space-y-5">
            {/* Context bar */}
            <div className="flex flex-wrap gap-4 rounded-md bg-muted p-3 max-sm:flex-col max-sm:gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Status
                </span>
                <Badge variant="outline" className={statusTone(rma.status)}>
                  {formatStatus(rma.status)}
                </Badge>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Reason
                </span>
                <span className="text-sm font-medium">
                  {rma.reasonCode ? formatStatus(rma.reasonCode) : "None"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Requested
                </span>
                <span className="text-sm font-medium">
                  {formatDateTime(rma.requestedAt)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Window
                </span>
                <span className="text-sm font-medium">
                  {rma.returnWindowDays} days
                </span>
              </div>
            </div>

            {/* Items table */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Items
              </h3>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU / Variant</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead>Condition</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {form.items.map((item) => (
                      <TableRow key={item.rmaItemId}>
                        <TableCell>
                          <div className="font-mono text-sm">
                            {item.productVariantId
                              ? `Variant ${item.productVariantId}`
                              : `Item ${item.rmaItemId}`}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {item.quantity}
                        </TableCell>
                        <TableCell>
                          <Select
                            value={item.status}
                            onValueChange={(value) =>
                              updateItem(item.rmaItemId, { status: value })
                            }
                            disabled={existingInspection !== null || pending}
                          >
                            <SelectTrigger className="h-8 w-[130px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {RETURN_INSPECTION_ITEM_STATUSES.map((s) => (
                                <SelectItem key={s} value={s}>
                                  {formatStatus(s)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={item.finalCreditAmount}
                            onChange={(e) =>
                              updateItem(item.rmaItemId, {
                                finalCreditAmount: e.target.value,
                              })
                            }
                            className="h-8 text-right font-mono"
                            disabled={existingInspection !== null || pending}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {rma.items.length === 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  This RMA has no item rows attached.
                </p>
              )}
            </div>

            {/* Fault category */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Fault &amp; Fees
              </h3>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Overall Return Responsibility
                  </label>
                  <Select
                    value={form.faultCategory}
                    onValueChange={(value) =>
                      updateForm({
                        faultCategory: value as DropshipReturnFaultCategory,
                      })
                    }
                    disabled={existingInspection !== null || pending}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="Select fault…" />
                    </SelectTrigger>
                    <SelectContent>
                      {FAULT_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {formatStatus(cat)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Fee decisions */}
              {feePolicyLoading && (
                <div className="mt-3 space-y-2">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )}
              {feePolicyError && (
                <Alert variant="destructive" className="mt-3">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {queryErrorMessage(
                      feePolicyError,
                      "Unable to load return fee policies.",
                    )}
                  </AlertDescription>
                </Alert>
              )}
              {!feePolicyLoading && !feePolicyError && feeLines.length > 0 && (
                <div className="mt-3 space-y-3">
                  {feeLines.map((line) => {
                    const amountCents = parseDollarInput(line.amount);
                    const needsReason =
                      line.responsibility !== line.defaultResponsibility ||
                      amountCents !== line.proposedAmountCents;
                    return (
                      <div key={line.feeType} className="rounded-md border p-3">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium">{line.label}</div>
                            <div className="text-xs text-muted-foreground">
                              Policy default:{" "}
                              {formatStatus(line.defaultResponsibility)}
                            </div>
                          </div>
                          <span className="font-mono text-sm text-amber-700">
                            {amountCents === null
                              ? "Invalid"
                              : formatCents(amountCents)}
                          </span>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">
                              Responsibility
                            </label>
                            <Select
                              value={line.responsibility}
                              onValueChange={(value) =>
                                updateFeeResponsibility(
                                  line.feeType,
                                  value as DropshipReturnFaultCategory,
                                )
                              }
                              disabled={existingInspection !== null || pending}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {FAULT_CATEGORIES.map((category) => (
                                  <SelectItem key={category} value={category}>
                                    {formatStatus(category)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">
                              Fee amount
                            </label>
                            <Input
                              value={line.amount}
                              onChange={(event) =>
                                updateFeeAmount(
                                  line.feeType,
                                  event.target.value,
                                )
                              }
                              className="text-right font-mono"
                              disabled={existingInspection !== null || pending}
                            />
                          </div>
                        </div>
                        {needsReason && (
                          <div className="mt-3 space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">
                              Override reason
                            </label>
                            <Textarea
                              value={line.overrideReason}
                              onChange={(event) =>
                                updateFeeReason(
                                  line.feeType,
                                  event.target.value,
                                )
                              }
                              placeholder="Required because responsibility or amount differs from policy"
                              maxLength={1000}
                              className="min-h-[60px]"
                              disabled={existingInspection !== null || pending}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
                    <span>Total Fees</span>
                    <span className="font-mono text-amber-700">
                      {hasInvalidFee ? "Invalid" : formatCents(totalFeeCents)}
                    </span>
                  </div>
                </div>
              )}
              {!feePolicyLoading &&
                !feePolicyError &&
                feeLines.length !== 3 && (
                  <Alert variant="destructive" className="mt-3">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      A default policy is required for each return fee type
                      before inspection can be finalized.
                    </AlertDescription>
                  </Alert>
                )}
            </div>

            {/* Credit section */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Credit
              </h3>
              <div className="rounded-md bg-muted p-3 space-y-1">
                {form.items.map((item) => {
                  const creditCents = parseDollarInput(item.finalCreditAmount);
                  return (
                    <div
                      key={item.rmaItemId}
                      className="flex items-center justify-between py-1 text-sm"
                    >
                      <span>
                        {item.productVariantId
                          ? `Variant ${item.productVariantId}`
                          : `Item ${item.rmaItemId}`}{" "}
                        × {item.quantity}
                      </span>
                      <span className="font-mono text-emerald-700">
                        {creditCents !== null
                          ? formatCents(creditCents)
                          : "Invalid"}
                      </span>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between border-t pt-2 font-semibold text-sm">
                  <span>Total Credit</span>
                  <span className="font-mono text-emerald-700">
                    {totals.hasInvalidAmount
                      ? "Invalid"
                      : formatCents(totals.creditCents)}
                  </span>
                </div>
              </div>
            </div>

            {/* Wallet movement summary */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Wallet Movement
              </h3>
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    Credit to vendor
                  </span>
                  <span className="font-mono font-medium text-emerald-700">
                    +
                    {totals.hasInvalidAmount
                      ? "—"
                      : formatCents(totals.creditCents)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Fees charged</span>
                  <span className="font-mono font-medium text-destructive">
                    −{hasInvalidFee ? "—" : formatCents(totalFeeCents)}
                  </span>
                </div>
                <div className="flex justify-between border-t border-primary/20 pt-2 font-bold">
                  <span>Net wallet movement</span>
                  <span
                    className={cn(
                      "font-mono",
                      netCents >= 0 ? "text-emerald-700" : "text-destructive",
                    )}
                  >
                    {totals.hasInvalidAmount || hasInvalidFee
                      ? "—"
                      : `${netCents >= 0 ? "+" : "−"}${formatCents(Math.abs(netCents))}`}
                  </span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Notes
              </h3>
              <Textarea
                placeholder="Inspection notes…"
                className="min-h-[60px]"
                maxLength={5000}
                value={form.notes}
                onChange={(e) => updateForm({ notes: e.target.value })}
                disabled={existingInspection !== null || pending}
              />
            </div>

            {(totals.hasInvalidAmount ||
              hasInvalidFee ||
              feeLineTotals.hasMissingReason) && (
              <p className="text-sm text-destructive">
                Credit and fee inputs must be valid dollar amounts, and every
                policy override requires a reason.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="max-sm:flex-col max-sm:gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="max-sm:w-full"
          >
            Cancel
          </Button>
          <div className="flex gap-2 max-sm:w-full max-sm:flex-col">
            <Button
              type="button"
              variant="destructive"
              disabled={rejectDisabled}
              onClick={() => handleSave("rejected")}
              className="gap-2 max-sm:w-full"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Reject Return
            </Button>
            <Button
              type="button"
              disabled={saveDisabled}
              onClick={() => handleSave("approved")}
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 max-sm:w-full"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Approve &amp; Credit
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
