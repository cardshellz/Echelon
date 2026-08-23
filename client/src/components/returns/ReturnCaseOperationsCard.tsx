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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  ReturnCaseAdminApiError,
  completeReturnInspection,
  createReturnCaseIdempotencyKey,
  recordReturnReceipt,
  startReturnInspection,
  type CompleteReturnInspectionResult,
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
  onRefreshRequested(): Promise<void>;
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
  onRefreshRequested,
}: ReturnCaseOperationsCardProps) {
  const [receiptAction, setReceiptAction] = useState<ReturnCaseAction | null>(null);
  const [inspectionAction, setInspectionAction] = useState<ReturnCaseAction | null>(null);
  const [completionDialogOpen, setCompletionDialogOpen] = useState(false);
  const [lastResult, setLastResult] = useState<ReturnCaseOperationResult | null>(null);
  const completionContext = resolveInspectionCompletionContext(actionPlan);

  useEffect(() => {
    if (completionDialogOpen && completionContext === null) setCompletionDialogOpen(false);
  }, [completionContext, completionDialogOpen]);

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
                    <ActionStateBadge
                      action={action}
                      isNext={actionPlan.nextAction === action.kind}
                    />
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
                {completionContext?.action === action && (
                  <Button type="button" size="sm" onClick={() => setCompletionDialogOpen(true)}>
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
      <CompleteReturnInspectionDialog
        open={completionDialogOpen && completionContext !== null}
        onOpenChange={setCompletionDialogOpen}
        returnCaseId={returnCaseId}
        action={completionContext?.action ?? null}
        inspection={completionContext?.inspection ?? null}
        items={items}
        onRefreshRequested={onRefreshRequested}
        onCompleted={(result) => {
          setCompletionDialogOpen(false);
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
          <DialogTitle>{action?.label ?? "Begin inspection"}</DialogTitle>
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
            {pending ? "Starting..." : (action?.label ?? "Begin inspection")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CompleteReturnInspectionOutcome = "approved" | "rejected";
type ReturnInspectionSummary = NonNullable<ReturnCaseActionPlan["inspectionSummary"]>;
type CompletionRefreshState = "idle" | "refreshing" | "refreshed" | "failed";

export interface InspectionCompletionContext {
  action: ReturnCaseAction;
  inspection: ReturnInspectionSummary;
}

export function resolveInspectionCompletionContext(
  actionPlan: ReturnCaseActionPlan,
): InspectionCompletionContext | null {
  const action = actionPlan.actions.find((candidate) => candidate.kind === "complete_inspection");
  const inspection = actionPlan.inspectionSummary;
  if (action?.state !== "available" || inspection?.status !== "in_progress") return null;
  return { action, inspection };
}

export function isReturnCaseConflict(error: unknown): error is ReturnCaseAdminApiError {
  return error instanceof ReturnCaseAdminApiError && error.status === 409;
}

export async function refreshReturnCaseAfterConflict(
  error: unknown,
  refresh: () => Promise<void>,
): Promise<Exclude<CompletionRefreshState, "idle" | "refreshing"> | "not_requested"> {
  if (!isReturnCaseConflict(error)) return "not_requested";
  try {
    await refresh();
    return "refreshed";
  } catch {
    return "failed";
  }
}

interface CompleteReturnInspectionDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  returnCaseId: number;
  action: ReturnCaseAction | null;
  inspection: ReturnInspectionSummary | null;
  items: readonly ReturnCaseDetailItem[];
  onCompleted(result: CompleteReturnInspectionResult): void;
  onRefreshRequested(): Promise<void>;
}

export function CompleteReturnInspectionDialog({
  open,
  onOpenChange,
  returnCaseId,
  action,
  inspection,
  items,
  onCompleted,
  onRefreshRequested,
}: CompleteReturnInspectionDialogProps) {
  const openInspectionId = useRef<number | null | undefined>(undefined);
  const [outcome, setOutcome] = useState<CompleteReturnInspectionOutcome | null>(null);
  const [notes, setNotes] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refreshState, setRefreshState] = useState<CompletionRefreshState>("idle");
  const inspectionId = inspection?.inspectionId ?? null;
  const returnedItems = items.filter((item) => item.receivedQuantity > 0);

  useEffect(() => {
    if (!open) {
      openInspectionId.current = undefined;
      return;
    }
    if (openInspectionId.current === inspectionId) return;
    openInspectionId.current = inspectionId;
    setOutcome(null);
    setNotes("");
    setAttempted(false);
    setPending(false);
    setError(null);
    setRefreshState("idle");
    try {
      setIdempotencyKey(createReturnCaseIdempotencyKey("complete_inspection"));
    } catch (caught) {
      setIdempotencyKey(null);
      setError(caught);
    }
  }, [inspectionId, open]);

  const refreshAfterConflict = async (operationError: unknown) => {
    if (!isReturnCaseConflict(operationError)) return;
    setRefreshState("refreshing");
    const nextState = await refreshReturnCaseAfterConflict(operationError, onRefreshRequested);
    setRefreshState(nextState === "not_requested" ? "idle" : nextState);
  };

  const payloadChanged = () => {
    setError(null);
    setRefreshState("idle");
    if (!attempted) return;
    setAttempted(false);
    try {
      setIdempotencyKey(createReturnCaseIdempotencyKey("complete_inspection"));
    } catch (caught) {
      setIdempotencyKey(null);
      setError(caught);
    }
  };

  const changeOutcome = (value: string) => {
    if (value !== "approved" && value !== "rejected") return;
    setOutcome(value);
    payloadChanged();
  };

  const submit = async () => {
    if (inspection?.status !== "in_progress" || outcome === null || idempotencyKey === null) return;
    setAttempted(true);
    setPending(true);
    setError(null);
    try {
      const result = await completeReturnInspection(returnCaseId, inspection.inspectionId, {
        idempotencyKey,
        outcome,
        notes,
      });
      onCompleted(result);
    } catch (caught) {
      setError(caught);
      await refreshAfterConflict(caught);
    } finally {
      setPending(false);
    }
  };

  const submitLabel = outcome === "approved"
    ? "Approve inspection"
    : outcome === "rejected"
      ? "Reject inspection"
      : (action?.label ?? "Complete inspection");

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{action?.label ?? "Complete inspection"}</DialogTitle>
          <DialogDescription>
            Review the physically received items and record the final inspection outcome.
          </DialogDescription>
        </DialogHeader>

        <CompleteReturnInspectionReview
          inspection={inspection}
          returnedItems={returnedItems}
          outcome={outcome}
          pending={pending}
          notes={notes}
          onOutcomeChange={changeOutcome}
          onNotesChange={(value) => {
            setNotes(value);
            payloadChanged();
          }}
        />
        {error !== null && <OperationError error={error} />}
        {refreshState === "refreshing" && (
          <Alert>
            <Loader2 className="animate-spin" />
            <AlertTitle>Refreshing return case</AlertTitle>
            <AlertDescription>Loading the latest persisted inspection state before another attempt.</AlertDescription>
          </Alert>
        )}
        {refreshState === "refreshed" && (
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Return case refreshed</AlertTitle>
            <AlertDescription>Review the current inspection state before trying again.</AlertDescription>
          </Alert>
        )}
        {refreshState === "failed" && (
          <Alert variant="destructive">
            <AlertTitle>Return case could not be refreshed</AlertTitle>
            <AlertDescription>Close this dialog and reopen the return case before trying again.</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {isReturnCaseConflict(error) && (
            <Button
              type="button"
              variant="outline"
              disabled={pending || refreshState === "refreshing"}
              onClick={() => void refreshAfterConflict(error)}
            >
              {refreshState === "refreshing" && <Loader2 className="animate-spin" />}
              Refresh return case
            </Button>
          )}
          <Button
            type="button"
            variant={outcome === "rejected" ? "destructive" : "default"}
            disabled={
              pending
              || refreshState === "refreshing"
              || outcome === null
              || inspection?.status !== "in_progress"
              || idempotencyKey === null
              || returnedItems.length === 0
            }
            onClick={() => void submit()}
          >
            {pending && <Loader2 className="animate-spin" />}
            {pending ? "Recording..." : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CompleteReturnInspectionReviewProps {
  inspection: ReturnInspectionSummary | null;
  returnedItems: readonly ReturnCaseDetailItem[];
  outcome: CompleteReturnInspectionOutcome | null;
  pending: boolean;
  notes: string;
  onOutcomeChange(value: string): void;
  onNotesChange(value: string): void;
}

export function CompleteReturnInspectionReview({
  inspection,
  returnedItems,
  outcome,
  pending,
  notes,
  onOutcomeChange,
  onNotesChange,
}: CompleteReturnInspectionReviewProps) {
  return (
    <>
      <Alert>
        <ClipboardCheck />
        <AlertTitle>Completion records the inspection result only</AlertTitle>
        <AlertDescription>
          This command does not restock inventory, issue a customer refund, settle a vendor balance,
          or close the return case.
        </AlertDescription>
      </Alert>

      {inspection?.status === "in_progress" ? (
        <div className="grid gap-2 border p-3 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground">Inspection</div>
            <div className="font-medium">#{inspection.inspectionId}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Started</div>
            <div className="font-medium">{new Date(inspection.startedAt).toLocaleString()}</div>
          </div>
        </div>
      ) : (
        <InlineError>Active inspection details are unavailable. Refresh the return case before continuing.</InlineError>
      )}

      <div className="overflow-x-auto border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Returned item</th>
              <th className="px-3 py-2 text-right font-medium">Received</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {returnedItems.map((item) => (
              <tr key={item.id}>
                <td className="px-3 py-2">
                  <div className="font-medium">{item.title || item.externalLineItemId || "Unnamed return line"}</div>
                  <div className="text-xs text-muted-foreground">{item.sku ?? "SKU not provided"}</div>
                </td>
                <td className="px-3 py-2 text-right">{item.receivedQuantity}</td>
              </tr>
            ))}
            {returnedItems.length === 0 && (
              <tr>
                <td colSpan={2} className="p-4 text-center text-muted-foreground">
                  No physically received items are available to inspect.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div>
        <div id="return-inspection-outcome-label" className="mb-2 text-sm font-medium">Inspection outcome *</div>
        <RadioGroup
          aria-labelledby="return-inspection-outcome-label"
          value={outcome ?? ""}
          disabled={pending}
          onValueChange={onOutcomeChange}
          className="grid gap-2 sm:grid-cols-2"
        >
          <label htmlFor="return-inspection-approved" className="flex cursor-pointer gap-3 border p-3">
            <RadioGroupItem id="return-inspection-approved" value="approved" />
            <span>
              <span className="block font-medium">Approve</span>
              <span className="block text-sm text-muted-foreground">The returned items passed inspection.</span>
            </span>
          </label>
          <label htmlFor="return-inspection-rejected" className="flex cursor-pointer gap-3 border p-3">
            <RadioGroupItem id="return-inspection-rejected" value="rejected" />
            <span>
              <span className="block font-medium">Reject</span>
              <span className="block text-sm text-muted-foreground">The returned items did not pass inspection.</span>
            </span>
          </label>
        </RadioGroup>
        {outcome === null && (
          <p className="mt-1 text-xs text-muted-foreground">Choose Approve or Reject to continue.</p>
        )}
      </div>

      <div>
        <label htmlFor="return-inspection-completion-notes" className="mb-1 block text-sm font-medium">
          Completion notes (optional)
        </label>
        <Textarea
          id="return-inspection-completion-notes"
          value={notes}
          maxLength={2_000}
          disabled={pending}
          placeholder="Condition, packaging, or other inspection evidence"
          onChange={(event) => onNotesChange(event.target.value)}
        />
      </div>
    </>
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

const ACTION_STATE_BADGE_CLASS_NAMES: Record<ReturnCaseAction["state"], string> = {
  available: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300",
  blocked: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300",
  not_applicable: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
};

function ActionStateBadge({
  action,
  isNext,
}: {
  action: ReturnCaseAction;
  isNext: boolean;
}) {
  const label = action.state === "available" && isNext
    ? "Next"
    : action.kind === "start_inspection" && action.state === "completed"
      ? "Started"
      : action.state === "not_applicable"
        ? "Not applicable"
        : titleCase(action.state);

  return (
    <Badge variant="outline" className={ACTION_STATE_BADGE_CLASS_NAMES[action.state]}>
      {label}
    </Badge>
  );
}

function OperationSuccess({ result }: { result: ReturnCaseOperationResult }) {
  const content = operationSuccessContent(result);
  return (
    <Alert className="border-green-600 text-green-800 dark:text-green-300">
      <CheckCircle2 />
      <AlertTitle>{content.title}</AlertTitle>
      <AlertDescription>{content.message}</AlertDescription>
    </Alert>
  );
}

function operationSuccessContent(result: ReturnCaseOperationResult): { title: string; message: string } {
  if (result.commandType === "record_receipt") {
    return {
      title: result.replayed ? "Receipt already recorded" : "Receipt recorded",
      message: `${result.receivedUnits} of ${result.expectedUnits} units are now recorded as received; ${result.remainingUnits} remain.`,
    };
  }
  if (result.commandType === "start_inspection") {
    return {
      title: result.replayed ? "Inspection was already started" : "Inspection started",
      message: `Inspection ${result.inspectionId} was started at ${new Date(result.startedAt).toLocaleString()}.`,
    };
  }
  const outcome = result.inspectionStatus === "approved" ? "approved" : "rejected";
  return {
    title: result.replayed
      ? `Inspection was already ${outcome}`
      : `Inspection ${outcome}`,
    message: `Inspection ${result.inspectionId} was ${outcome} at ${new Date(result.completedAt).toLocaleString()}.`,
  };
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
