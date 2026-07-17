/**
 * Review & activate (spec §8.5): summarizes the saved draft, splits
 * validation into blocking errors / warnings / notes with jump-to-group
 * remediation, shows what changes against the live revision, and gates
 * activation behind an explicit confirmation. Warnings use the API's
 * two-phase confirm flow so the server stays the source of truth.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Info,
  Loader2,
  Rocket,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  describeMeasureRange,
  diffRateRows,
  groupDisplayName,
  usdFromCents,
  type DraftRow,
  type PricingBasis,
  type RateGroup,
} from "../rate-table-model";
import {
  ShippingApiError,
  assignmentLabel,
  formatDate,
  getJson,
  postJson,
  rateTableDetailKey,
  type RateBookSummary,
  type RateTableAnalysis,
  type RateTableDetail,
  type RateTableSummary,
  type ServiceLevelOption,
} from "./api";

interface ReviewStepProps {
  draftId: number;
  analysis: RateTableAnalysis | null;
  groups: RateGroup[];
  savedRows: DraftRow[];
  pricingBasis: PricingBasis;
  rateBook: RateBookSummary | null;
  serviceLevel: ServiceLevelOption | null;
  activeTable: RateTableSummary | null;
  onJumpToGroup: (groupId: string) => void;
  onActivated: () => void;
}

export function ReviewStep({
  draftId,
  analysis,
  groups,
  savedRows,
  pricingBasis,
  rateBook,
  serviceLevel,
  activeTable,
  onJumpToGroup,
  onActivated,
}: ReviewStepProps) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingWarnings, setPendingWarnings] = useState<string[]>([]);

  const { data: activeDetail, isLoading: activeLoading } = useQuery<RateTableDetail>({
    queryKey: [rateTableDetailKey(activeTable?.id ?? 0)],
    queryFn: () => getJson<RateTableDetail>(rateTableDetailKey(activeTable!.id)),
    enabled: activeTable !== null,
  });

  const diff = useMemo(
    () => activeDetail
      ? diffRateRows(savedRows, activeDetail.rows, pricingBasis)
      : null,
    [savedRows, activeDetail, pricingBasis],
  );

  const activateMutation = useMutation({
    mutationFn: (confirmWarnings: boolean) => postJson<{ rateTable: unknown; warnings: string[] }>(
      `/api/shipping/admin/rate-tables/${draftId}/activate`,
      { confirmWarnings },
    ),
    onSuccess: () => {
      toast({
        title: "Rates activated",
        description: activeTable
          ? "The previous revision is superseded and remains inspectable in history."
          : "This shipping option now has live rates for this program.",
      });
      setConfirmOpen(false);
      onActivated();
    },
    onError: (error: Error) => {
      if (error instanceof ShippingApiError && error.code === "SHIPPING_ADMIN_ACTIVATION_CONFIRMATION_REQUIRED") {
        setPendingWarnings(error.details);
        setConfirmOpen(true);
        return;
      }
      toast({ title: "Activation failed", description: error.message, variant: "destructive" });
    },
  });

  const blockingErrors = analysis?.errors ?? [];
  const warnings = analysis?.warnings ?? [];
  const coverage = analysis?.coverage ?? null;

  /** Best-effort mapping from a server message back to the offending group. */
  const groupForMessage = (message: string): RateGroup | null => {
    const stateToken = message.match(/^([A-Z]{2})\b/)?.[1] ?? null;
    if (stateToken === null) return null;
    return groups.find((group) =>
      group.regions.includes(stateToken)
      || group.zipEntries.some((entry) => entry.state === stateToken)) ?? null;
  };

  const activeAssignments = rateBook?.assignments.filter((assignment) => assignment.isActive) ?? [];

  return (
    <div className="max-w-4xl space-y-5">
      {/* Context summary */}
      <section className="grid gap-3 rounded-md border p-4 sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-muted-foreground">Pricing program</div>
          <div className="mt-0.5 text-sm font-semibold">{rateBook?.name ?? "—"}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {activeAssignments.length === 0 ? (
              <span className="text-xs text-muted-foreground">Not used by any channel yet</span>
            ) : (
              activeAssignments.map((assignment) => (
                <Badge key={assignment.id} variant="outline" className="font-normal">
                  {assignmentLabel(assignment)}
                </Badge>
              ))
            )}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground">Shipping option</div>
          <div className="mt-0.5 text-sm font-semibold">{serviceLevel?.displayName ?? "—"}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {pricingBasis === "pallet_count" ? "Freight · priced by pallet count" : "Parcel · priced by total shipment weight"}
            {" · USD · activates immediately upon confirmation"}
          </div>
        </div>
      </section>

      {/* Coverage summary */}
      {coverage && (
        <section className="grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-5">
          <Stat label="Destination groups" value={groups.length.toLocaleString()} />
          <Stat label="States covered" value={String(coverage.stateCount)} />
          <Stat label="ZIP overrides" value={String(coverage.zipOverrideCount)} />
          <Stat
            label={pricingBasis === "pallet_count" ? "Pallet coverage" : "Weight coverage"}
            value={describeMeasureRange(pricingBasis, coverage.minMeasure, coverage.maxMeasure)}
          />
          <Stat label="Rate rows generated" value={coverage.rowCount.toLocaleString()} />
        </section>
      )}

      {/* Changes vs live */}
      <section className="rounded-md border p-4">
        <h3 className="text-sm font-semibold">Changes from the live revision</h3>
        {activeTable === null ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            This is the first revision for {serviceLevel?.displayName ?? "this option"} in this
            program — there is no live revision to compare against.
          </p>
        ) : activeLoading || !diff ? (
          <div className="mt-2 space-y-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : diff.identical ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            Identical to the revision active since {formatDate(activeTable.effectiveFrom)} —
            activating changes nothing for shoppers or vendors.
          </p>
        ) : (
          <div className="mt-2 space-y-3 text-sm">
            <div className="flex flex-wrap gap-4 text-muted-foreground">
              <span><span className="font-semibold text-foreground">{diff.changedCount}</span> price change{diff.changedCount === 1 ? "" : "s"}</span>
              <span><span className="font-semibold text-foreground">{diff.addedBands}</span> new band{diff.addedBands === 1 ? "" : "s"}</span>
              <span><span className="font-semibold text-foreground">{diff.removedBands}</span> removed band{diff.removedBands === 1 ? "" : "s"}</span>
            </div>
            {diff.changedRates.length > 0 && (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                      <th className="px-3 py-1.5 font-medium">Destination</th>
                      <th className="px-3 py-1.5 font-medium">Band</th>
                      <th className="px-3 py-1.5 text-right font-medium">Current</th>
                      <th className="px-3 py-1.5 text-right font-medium">New</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.changedRates.map((change, index) => (
                      <tr key={index} className="border-b last:border-b-0">
                        <td className="px-3 py-1.5">{change.scopeLabel}</td>
                        <td className="whitespace-nowrap px-3 py-1.5">{change.bandLabel}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {usdFromCents(change.fromCents)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                          {usdFromCents(change.toCents)}
                          <span className={change.toCents > change.fromCents ? "ml-1 text-destructive" : "ml-1 text-emerald-600"}>
                            {change.toCents > change.fromCents ? "↑" : "↓"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {diff.changedCount > diff.changedRates.length && (
                  <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                    …and {diff.changedCount - diff.changedRates.length} more price changes.
                  </p>
                )}
              </div>
            )}
            {(diff.addedScopes.length > 0 || diff.removedScopes.length > 0) && (
              <div className="grid gap-2 sm:grid-cols-2">
                {diff.addedScopes.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Newly covered:</span>{" "}
                    {diff.addedScopes.slice(0, 12).join(", ")}
                    {diff.addedScopes.length > 12 && ` +${diff.addedScopes.length - 12} more`}
                  </p>
                )}
                {diff.removedScopes.length > 0 && (
                  <p className="text-xs text-amber-700">
                    <span className="font-medium">No longer covered:</span>{" "}
                    {diff.removedScopes.slice(0, 12).join(", ")}
                    {diff.removedScopes.length > 12 && ` +${diff.removedScopes.length - 12} more`}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Validation hierarchy */}
      {blockingErrors.length > 0 && (
        <section className="rounded-md border border-destructive/50 bg-destructive/5 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <CircleAlert className="h-4 w-4" />
            {blockingErrors.length} blocking error{blockingErrors.length === 1 ? "" : "s"} — activation is disabled
          </h3>
          <ul className="mt-2 space-y-1.5">
            {blockingErrors.map((message) => {
              const group = groupForMessage(message);
              return (
                <li key={message} className="flex items-start justify-between gap-3 text-xs text-destructive">
                  <span>{message}</span>
                  {group && (
                    <button
                      type="button"
                      onClick={() => onJumpToGroup(group.id)}
                      className="flex shrink-0 items-center gap-0.5 font-medium underline-offset-2 hover:underline"
                    >
                      Fix in {groupDisplayName(group, groups.indexOf(group))}
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {warnings.length > 0 && (
        <section className="rounded-md border border-amber-300 bg-amber-50 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4" />
            Review before activating
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-900">
            {warnings.map((message) => <li key={message}>{message}</li>)}
          </ul>
        </section>
      )}

      <section className="rounded-md border p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Info className="h-4 w-4 text-muted-foreground" />
          When you activate
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {activeTable ? (
            <li>
              The revision active since {formatDate(activeTable.effectiveFrom)} becomes
              superseded immediately and stays inspectable in revision history.
            </li>
          ) : (
            <li>This becomes the first live revision for this option in this program.</li>
          )}
          <li>{savedRows.length.toLocaleString()} rate rows begin serving quotes immediately.</li>
          {serviceLevel && !serviceLevel.isActive && (
            <li className="text-amber-700">
              {serviceLevel.displayName} is inactive, so these rates stay dormant until the
              option is activated on the Shipping options tab.
            </li>
          )}
        </ul>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <DeleteDraftButton draftId={draftId} onDeleted={onActivated} />
        <Button
          size="lg"
          disabled={blockingErrors.length > 0 || activateMutation.isPending || analysis === null}
          onClick={() => {
            setPendingWarnings(warnings);
            setConfirmOpen(true);
          }}
        >
          {activateMutation.isPending
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <Rocket className="mr-2 h-4 w-4" />}
          Activate now
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate these rates?</AlertDialogTitle>
            <AlertDialogDescription>
              {rateBook?.name} · {serviceLevel?.displayName} — effective immediately.
              {activeTable && " The current live revision will be superseded."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingWarnings.length > 0 && (
            <div className="max-h-44 overflow-y-auto rounded-md border border-amber-300 bg-amber-50 p-3">
              <ul className="list-disc space-y-1 pl-4 text-xs text-amber-900">
                {pendingWarnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={activateMutation.isPending}>Cancel</AlertDialogCancel>
            <Button
              onClick={() => activateMutation.mutate(true)}
              disabled={activateMutation.isPending}
            >
              {activateMutation.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Activate
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function DeleteDraftButton({ draftId, onDeleted }: { draftId: number; onDeleted: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/shipping/admin/rate-tables/${draftId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error(`Could not delete the draft (${response.status}).`);
    },
    onSuccess: () => {
      toast({ title: "Draft deleted", description: "Live quoting was never affected." });
      setOpen(false);
      onDeleted();
    },
    onError: (error: Error) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  return (
    <>
      <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        <Trash2 className="mr-2 h-4 w-4" />
        Delete draft
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft and its rate rows are permanently removed. The live revision, if any,
              keeps quoting unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Keep draft</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete draft
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
