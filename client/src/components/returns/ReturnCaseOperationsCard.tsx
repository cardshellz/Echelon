import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, ClipboardCheck, Loader2, PackageCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ReturnCaseAdminApiError,
  createReturnCaseIdempotencyKey,
  recordReturnReceipt,
  startReturnInspection,
  type RecordReturnReceiptResult,
  type ReturnCaseAction,
  type ReturnCaseActionPlan,
  type ReturnCaseDetailItem,
  type ReturnCaseOperationResult,
  type StartReturnInspectionResult,
} from "./return-case-admin-api";

export interface ReturnCaseOperationsCardProps {
  returnCaseId: number;
  actionPlan: ReturnCaseActionPlan;
  items: readonly ReturnCaseDetailItem[];
  onOperationCompleted?(result: ReturnCaseOperationResult): void;
}

export interface ReceiptDraftLine {
  returnCaseItemId: number;
  title: string;
  sku: string | null;
  expectedQuantity: number;
  receivedQuantity: number;
  remainingQuantity: number;
  quantityReceivedNow: string;
}

export type ReceiptDraftValidation =
  | {
      success: true;
      lines: Array<{
        returnCaseItemId: number;
        expectedCurrentReceivedQuantity: number;
        quantityReceivedNow: number;
      }>;
      fieldErrors: Readonly<Record<number, string>>;
      formError: null;
    }
  | {
      success: false;
      lines: [];
      fieldErrors: Readonly<Record<number, string>>;
      formError: string;
    };

/**
 * The server owns action availability. This component only renders and invokes
 * actions present in the supplied action plan; it never re-derives lifecycle
 * eligibility from display statuses.
 */
export function ReturnCaseOperationsCard({
  returnCaseId,
  actionPlan,
  items,
  onOperationCompleted,
}: ReturnCaseOperationsCardProps) {
  const [receiptAction, setReceiptAction] = useState<ReturnCaseAction | null>(null);
  const [inspectionAction, setInspectionAction] = useState<ReturnCaseAction | null>(null);
  const [lastResult, setLastResult] = useState<ReturnCaseOperationResult | null>(null);

  const complete = (result: ReturnCaseOperationResult) => {
    setLastResult(result);
    onOperationCompleted?.(result);
  };

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="text-base">Operations</CardTitle>
        <p className="text-sm text-muted-foreground">
          Available actions are determined from the persisted return and receipt state.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <div className="grid gap-2 sm:grid-cols-3">
          <ReceiptMetric label="Expected" value={actionPlan.receiptSummary.expectedUnits} />
          <ReceiptMetric label="Received" value={actionPlan.receiptSummary.receivedUnits} />
          <ReceiptMetric label="Remaining" value={actionPlan.receiptSummary.remainingUnits} />
        </div>

        {lastResult && <OperationSuccess result={lastResult} />}

        {actionPlan.actions.length === 0 ? (
          <div className="border p-3 text-sm text-muted-foreground">
            The server did not provide any operations for this return case.
          </div>
        ) : (
          <div className="divide-y border">
            {actionPlan.actions.map((action) => (
              <div
                key={action.kind}
                className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{action.label}</span>
                    <ActionStateBadge state={action.state} />
                    {actionPlan.nextAction === action.kind && action.state === "available" && (
                      <Badge>Next</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{action.description}</p>
                  {action.reasonCode && (
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{action.reasonCode}</p>
                  )}
                </div>
                {action.state === "available" && action.kind === "record_receipt" && (
                  <Button type="button" size="sm" onClick={() => setReceiptAction(action)}>
                    <PackageCheck />
                    {action.label}
                  </Button>
                )}
                {action.state === "available" && action.kind === "start_inspection" && (
                  <Button type="button" size="sm" onClick={() => setInspectionAction(action)}>
                    <ClipboardCheck />
                    {action.label}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <RecordReturnReceiptDialog
        open={receiptAction !== null}
        onOpenChange={(open) => !open && setReceiptAction(null)}
        returnCaseId={returnCaseId}
        action={receiptAction}
        items={items}
        onCompleted={(result) => {
          setReceiptAction(null);
          complete(result);
        }}
      />
      <StartReturnInspectionDialog
        open={inspectionAction !== null}
        onOpenChange={(open) => !open && setInspectionAction(null)}
        returnCaseId={returnCaseId}
        action={inspectionAction}
        onCompleted={(result) => {
          setInspectionAction(null);
          complete(result);
        }}
      />
    </Card>
  );
}

interface RecordReturnReceiptDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  returnCaseId: number;
  action: ReturnCaseAction | null;
  items: readonly ReturnCaseDetailItem[];
  onCompleted(result: RecordReturnReceiptResult): void;
}

export function RecordReturnReceiptDialog({
  open,
  onOpenChange,
  returnCaseId,
  action,
  items,
  onCompleted,
}: RecordReturnReceiptDialogProps) {
  const wasOpen = useRef(false);
  const initialDraft = useMemo(() => createReceiptDraft(items), [items]);
  const [draft, setDraft] = useState<ReceiptDraftLine[]>(initialDraft);
  const [notes, setNotes] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const validation = useMemo(() => validateReceiptDraft(draft), [draft]);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setDraft(createReceiptDraft(items));
    setNotes("");
    setAttempted(false);
    setPending(false);
    setError(null);
    try {
      setIdempotencyKey(createReturnCaseIdempotencyKey("record_receipt"));
    } catch (caught) {
      setIdempotencyKey(null);
      setError(caught);
    }
  }, [items, open]);

  const payloadChanged = () => {
    setError(null);
    if (!attempted) return;
    setAttempted(false);
    try {
      setIdempotencyKey(createReturnCaseIdempotencyKey("record_receipt"));
    } catch (caught) {
      setIdempotencyKey(null);
      setError(caught);
    }
  };

  const submit = async () => {
    const parsed = validateReceiptDraft(draft);
    if (!parsed.success || idempotencyKey === null) return;
    setAttempted(true);
    setPending(true);
    setError(null);
    try {
      const result = await recordReturnReceipt(returnCaseId, {
        idempotencyKey,
        lines: parsed.lines,
        notes,
      });
      onCompleted(result);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{action?.label ?? "Record receipt"}</DialogTitle>
          <DialogDescription>
            Enter only the units physically received now. Receipt does not make inventory available;
            disposition remains pending inspection.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-x-auto border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Expected</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
                <th className="px-3 py-2 text-right font-medium">Remaining</th>
                <th className="w-36 px-3 py-2 font-medium">Receive now</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {draft.map((line, index) => (
                <tr key={line.returnCaseItemId}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{line.title}</div>
                    <div className="text-xs text-muted-foreground">{line.sku ?? "SKU not provided"}</div>
                  </td>
                  <td className="px-3 py-2 text-right">{line.expectedQuantity}</td>
                  <td className="px-3 py-2 text-right">{line.receivedQuantity}</td>
                  <td className="px-3 py-2 text-right">{line.remainingQuantity}</td>
                  <td className="px-3 py-2 align-top">
                    <Input
                      aria-label={`Receive now for ${line.title}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={line.remainingQuantity}
                      step={1}
                      value={line.quantityReceivedNow}
                      disabled={pending}
                      aria-invalid={validation.fieldErrors[line.returnCaseItemId] ? true : undefined}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => current.map((candidate, candidateIndex) => (
                          candidateIndex === index
                            ? { ...candidate, quantityReceivedNow: value }
                            : candidate
                        )));
                        payloadChanged();
                      }}
                    />
                    {validation.fieldErrors[line.returnCaseItemId] && (
                      <p className="mt-1 text-xs text-destructive">
                        {validation.fieldErrors[line.returnCaseItemId]}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
              {draft.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-muted-foreground">
                    No receipt lines have remaining units.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <label htmlFor="return-receipt-notes" className="mb-1 block text-sm font-medium">
            Receipt notes
          </label>
          <Textarea
            id="return-receipt-notes"
            value={notes}
            maxLength={2_000}
            disabled={pending}
            placeholder="Optional receiving evidence or package condition"
            onChange={(event) => {
              setNotes(event.target.value);
              payloadChanged();
            }}
          />
        </div>

        {!validation.success && validation.formError && (
          <InlineError>{validation.formError}</InlineError>
        )}
        {error !== null && <OperationError error={error} />}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || !validation.success || idempotencyKey === null}
            onClick={() => void submit()}
          >
            {pending && <Loader2 className="animate-spin" />}
            {pending ? "Recording..." : (action?.label ?? "Record receipt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface StartReturnInspectionDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  returnCaseId: number;
  action: ReturnCaseAction | null;
  onCompleted(result: StartReturnInspectionResult): void;
}

export function StartReturnInspectionDialog({
  open,
  onOpenChange,
  returnCaseId,
  action,
  onCompleted,
}: StartReturnInspectionDialogProps) {
  const [notes, setNotes] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setNotes("");
    setAttempted(false);
    setPending(false);
    setError(null);
    try {
      setIdempotencyKey(createReturnCaseIdempotencyKey("start_inspection"));
    } catch (caught) {
      setIdempotencyKey(null);
      setError(caught);
    }
  }, [open]);

  const changeNotes = (value: string) => {
    setNotes(value);
    setError(null);
    if (!attempted) return;
    setAttempted(false);
    try {
      setIdempotencyKey(createReturnCaseIdempotencyKey("start_inspection"));
    } catch (caught) {
      setIdempotencyKey(null);
      setError(caught);
    }
  };

  const submit = async () => {
    if (idempotencyKey === null) return;
    setAttempted(true);
    setPending(true);
    setError(null);
    try {
      const result = await startReturnInspection(returnCaseId, { idempotencyKey, notes });
      onCompleted(result);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action?.label ?? "Start inspection"}</DialogTitle>
          <DialogDescription>
            {action?.description ?? "Begin inspection of the physically received return."}
          </DialogDescription>
        </DialogHeader>
        <Alert>
          <ClipboardCheck />
          <AlertTitle>Inspection changes workflow state only</AlertTitle>
          <AlertDescription>
            This command does not restock inventory, issue a customer refund, or settle a vendor balance.
          </AlertDescription>
        </Alert>
        <div>
          <label htmlFor="return-inspection-notes" className="mb-1 block text-sm font-medium">
            Inspection notes
          </label>
          <Textarea
            id="return-inspection-notes"
            value={notes}
            maxLength={2_000}
            disabled={pending}
            placeholder="Optional inspection context"
            onChange={(event) => changeNotes(event.target.value)}
          />
        </div>
        {error !== null && <OperationError error={error} />}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={pending || idempotencyKey === null} onClick={() => void submit()}>
            {pending && <Loader2 className="animate-spin" />}
            {pending ? "Starting..." : (action?.label ?? "Start inspection")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function createReceiptDraft(
  items: readonly ReturnCaseDetailItem[],
): ReceiptDraftLine[] {
  return items
    .filter((item) => item.remainingQuantity > 0)
    .map((item) => ({
      returnCaseItemId: item.id,
      title: item.title || item.externalLineItemId || "Unnamed return line",
      sku: item.sku,
      expectedQuantity: item.expectedQuantity,
      receivedQuantity: item.receivedQuantity,
      remainingQuantity: item.remainingQuantity,
      quantityReceivedNow: "",
    }));
}

export function validateReceiptDraft(
  draft: readonly ReceiptDraftLine[],
): ReceiptDraftValidation {
  const fieldErrors: Record<number, string> = {};
  const lines: Array<{
    returnCaseItemId: number;
    expectedCurrentReceivedQuantity: number;
    quantityReceivedNow: number;
  }> = [];
  const seenIds = new Set<number>();

  for (const line of draft) {
    if (!Number.isSafeInteger(line.returnCaseItemId) || line.returnCaseItemId <= 0) {
      fieldErrors[line.returnCaseItemId] = "Return item identity is invalid.";
      continue;
    }
    if (seenIds.has(line.returnCaseItemId)) {
      fieldErrors[line.returnCaseItemId] = "This return item appears more than once.";
      continue;
    }
    seenIds.add(line.returnCaseItemId);

    if (!Number.isSafeInteger(line.receivedQuantity) || line.receivedQuantity < 0) {
      fieldErrors[line.returnCaseItemId] = "Displayed received quantity is invalid. Refresh the return case.";
      continue;
    }

    const normalized = line.quantityReceivedNow.trim();
    if (normalized === "") continue;
    const quantity = Number(normalized);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      fieldErrors[line.returnCaseItemId] = "Enter a whole number of zero or more.";
      continue;
    }
    if (quantity > line.remainingQuantity) {
      fieldErrors[line.returnCaseItemId] = `No more than ${line.remainingQuantity} unit${plural(line.remainingQuantity)} remain.`;
      continue;
    }
    if (quantity > 0) {
      lines.push({
        returnCaseItemId: line.returnCaseItemId,
        expectedCurrentReceivedQuantity: line.receivedQuantity,
        quantityReceivedNow: quantity,
      });
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      success: false,
      lines: [],
      fieldErrors: Object.freeze(fieldErrors),
      formError: "Correct the receipt quantities before continuing.",
    };
  }
  if (lines.length === 0) {
    return {
      success: false,
      lines: [],
      fieldErrors: Object.freeze(fieldErrors),
      formError: "Enter at least one unit received now.",
    };
  }
  return {
    success: true,
    lines: lines.sort((left, right) => left.returnCaseItemId - right.returnCaseItemId),
    fieldErrors: Object.freeze(fieldErrors),
    formError: null,
  };
}

function ReceiptMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function ActionStateBadge({ state }: { state: ReturnCaseAction["state"] }) {
  const label = state === "not_applicable" ? "Not applicable" : titleCase(state);
  const variant = state === "available" ? "default" : "outline";
  return <Badge variant={variant}>{label}</Badge>;
}

function OperationSuccess({ result }: { result: ReturnCaseOperationResult }) {
  const message = result.commandType === "record_receipt"
    ? `${result.receivedUnits} of ${result.expectedUnits} units are now recorded as received; ${result.remainingUnits} remain.`
    : `Inspection ${result.inspectionId} was started at ${new Date(result.startedAt).toLocaleString()}.`;
  return (
    <Alert className="border-green-600 text-green-800 dark:text-green-300">
      <CheckCircle2 />
      <AlertTitle>{result.replayed ? "Operation already recorded" : "Operation completed"}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function OperationError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Return case operation failed.";
  const code = error instanceof ReturnCaseAdminApiError ? error.code : null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Operation could not be completed</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {code && <p className="mt-1 font-mono text-xs">{code}</p>}
      </AlertDescription>
    </Alert>
  );
}

function InlineError({ children }: { children: ReactNode }) {
  return <div className="border border-destructive p-3 text-sm text-destructive">{children}</div>;
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function plural(value: number): string {
  return value === 1 ? "" : "s";
}
