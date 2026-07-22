/**
 * Full-page draft editor (spec §7.3): Context → Destinations & rates →
 * Review & activate, with a persistent action bar. Drafts save with
 * incomplete work preserved exactly (rows + editor layout); activation is
 * strictly validated server-side.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDashed,
  Download,
  Loader2,
  Save,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  defaultBands,
  downloadTextFile,
  emitDraftRows,
  groupsFromRows,
  layoutFromGroups,
  newGroup,
  serializeRowsToCsv,
  validateRateGroups,
  type PricingBasis,
  type RateGroup,
} from "../rate-table-model";
import {
  assignmentLabel,
  invalidateShippingAdmin,
  saveDraft,
  type RateBookSummary,
  type RateTableAnalysis,
  type RateTableSummary,
  type ServiceLevelOption,
  type WarehouseOption,
} from "./api";
import { CsvImportDialog } from "./CsvImportDialog";
import { DestinationGroupsPanel } from "./DestinationGroupsPanel";
import { ReviewStep } from "./ReviewStep";

export interface EditorLaunch {
  draftId: number | null;
  rateBookCode: string | null;
  serviceLevelCode: string | null;
  /** Hydrated groups when resuming a draft or cloning a revision. */
  groups: RateGroup[] | null;
  /** Launched from a program context: the program select stays fixed. */
  lockProgram: boolean;
}
interface RateTableEditorProps {
  launch: EditorLaunch;
  rateBooks: RateBookSummary[];
  serviceLevels: ServiceLevelOption[];
  warehouses: WarehouseOption[];
  /** Active revision summaries so review can diff draft vs live. */
  rateTables: RateTableSummary[];
  onExit: () => void;
}

type EditorStep = "context" | "rates" | "review";

export function RateTableEditor({
  launch,
  rateBooks,
  serviceLevels,
  warehouses,
  rateTables,
  onExit,
}: RateTableEditorProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<EditorStep>(
    launch.rateBookCode && launch.serviceLevelCode ? "rates" : "context",
  );
  const [rateBookCode, setRateBookCode] = useState(launch.rateBookCode ?? "");
  const [serviceLevelCode, setServiceLevelCode] = useState(launch.serviceLevelCode ?? "");
  const [draftId, setDraftId] = useState<number | null>(launch.draftId);
  const [groups, setGroups] = useState<RateGroup[]>(launch.groups ?? []);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    launch.groups?.[0]?.id ?? null,
  );
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(launch.draftId ? new Date() : null);
  const [serverAnalysis, setServerAnalysis] = useState<RateTableAnalysis | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const selectedBook = rateBooks.find((book) => book.code === rateBookCode) ?? null;
  const selectedLevel = serviceLevels.find((level) => level.code === serviceLevelCode) ?? null;
  const pricingBasis: PricingBasis = selectedLevel?.fulfillmentMode === "freight"
    ? "pallet_count"
    : "shipment_weight";

  // Switching between a parcel and a freight option changes the pricing
  // basis; destinations survive but band values no longer apply.
  const previousBasis = useRef(pricingBasis);
  useEffect(() => {
    if (previousBasis.current === pricingBasis) return;
    previousBasis.current = pricingBasis;
    setGroups((current) => current.map((group) => ({
      ...group,
      pricingModel: "weight_bands",
      bands: defaultBands(pricingBasis),
    })));
  }, [pricingBasis]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const validation = useMemo(
    () => validateRateGroups(groups, pricingBasis),
    [groups, pricingBasis],
  );
  const issueMessagesByGroup = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of validation.issues) {
      map.set(issue.groupId, [...(map.get(issue.groupId) ?? []), issue.message]);
    }
    return map;
  }, [validation.issues]);

  const draftRows = useMemo(
    () => emitDraftRows(groups, pricingBasis),
    [groups, pricingBasis],
  );

  const activeTable = useMemo(() => {
    if (!selectedBook || !selectedLevel) return null;
    return rateTables.find((table) =>
      table.rateBookId === selectedBook.id
      && table.serviceLevelId === selectedLevel.id
      && table.status === "active") ?? null;
  }, [rateTables, selectedBook, selectedLevel]);

  const updateGroups = (next: RateGroup[]) => {
    setGroups(next);
    setDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => saveDraft({
      draftId,
      rateBookCode,
      serviceLevelCode,
      pricingBasis,
      rows: draftRows,
      draftLayout: layoutFromGroups(groups),
      allowIncomplete: true,
    }),
    onSuccess: (result) => {
      setDraftId(result.rateTable.id);
      setDirty(false);
      setLastSavedAt(new Date());
      setServerAnalysis(result.analysis);
      invalidateShippingAdmin(queryClient);
    },
    onError: (error: Error) => {
      toast({ title: "Could not save the draft", description: error.message, variant: "destructive" });
    },
  });

  const handleSaveDraft = () => {
    saveMutation.mutate(undefined, {
      onSuccess: () => toast({ title: "Draft saved", description: "Live quoting is unaffected until you activate." }),
    });
  };

  const handleReview = () => {
    // Review always reflects the just-saved server truth.
    saveMutation.mutate(undefined, {
      onSuccess: () => setStep("review"),
    });
  };

  const handleExit = () => {
    if (dirty) setConfirmDiscard(true);
    else onExit();
  };

  const handleExportCsv = () => {
    const rows = draftRows;
    if (rows.length === 0) {
      toast({ title: "Nothing to export yet", description: "Complete at least one band first." });
      return;
    }
    const warehouseNames = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse.name]));
    downloadTextFile(
      `${rateBookCode || "rates"}-${serviceLevelCode || "option"}-draft.csv`,
      serializeRowsToCsv(rows, pricingBasis, warehouseNames),
    );
  };

  const stepIndex: Record<EditorStep, number> = { context: 0, rates: 1, review: 2 };
  const contextComplete = rateBookCode !== ""
    && serviceLevelCode !== ""
    && selectedLevel?.isActive === true;

  return (
    <div className="space-y-5 pb-24">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon" onClick={handleExit} aria-label="Back to pricing program">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">
                {draftId === null ? "New rates" : "Edit draft"}
                {selectedLevel ? ` — ${selectedLevel.displayName}` : ""}
              </h2>
              <Badge variant="secondary" className="gap-1">
                <CircleDashed className="h-3 w-3" />
                Draft
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {selectedBook ? selectedBook.name : "Choose where these prices are used."}
              {" · "}
              {saveMutation.isPending
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : lastSavedAt
                    ? `Saved ${lastSavedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
                    : "Not saved yet"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setCsvOpen(true)} disabled={!contextComplete}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Import CSV
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={!contextComplete}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Stepper */}
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {([
          ["context", "1. Context"],
          ["rates", "2. Destinations, rates & rules"],
          ["review", "3. Review & activate"],
        ] as Array<[EditorStep, string]>).map(([key, label], index) => {
          const enabled = key === "context"
            || (key === "rates" && contextComplete)
            || (key === "review" && contextComplete);
          const current = step === key;
          const complete = stepIndex[step] > index;
          return (
            <li key={key} className="flex items-center gap-1">
              {index > 0 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" />}
              <button
                type="button"
                disabled={!enabled}
                onClick={() => {
                  if (key === "review") handleReview();
                  else setStep(key);
                }}
                className={cn(
                  "rounded-md px-2.5 py-1.5 font-medium transition-colors",
                  current ? "bg-primary text-primary-foreground"
                    : complete ? "text-foreground hover:bg-muted"
                      : "text-muted-foreground hover:bg-muted disabled:opacity-50",
                )}
                aria-current={current ? "step" : undefined}
              >
                {complete && !current ? <Check className="mr-1 inline h-3.5 w-3.5" /> : null}
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {/* Step body */}
      {step === "context" && (
        <ContextStep
          rateBooks={rateBooks}
          serviceLevels={serviceLevels}
          rateBookCode={rateBookCode}
          serviceLevelCode={serviceLevelCode}
          lockProgram={launch.lockProgram}
          onSelectBook={(code) => { setRateBookCode(code); setDirty(true); }}
          onSelectLevel={(code) => {
            setServiceLevelCode(code);
            setDirty(true);
            if (groups.length === 0) {
              const level = serviceLevels.find((item) => item.code === code);
              const basis: PricingBasis = level?.fulfillmentMode === "freight" ? "pallet_count" : "shipment_weight";
              const seeded = [newGroup(basis)];
              setGroups(seeded);
              setSelectedGroupId(seeded[0].id);
            }
          }}
        />
      )}

      {step === "rates" && (
        <DestinationGroupsPanel
          groups={groups}
          onChange={updateGroups}
          pricingBasis={pricingBasis}
          warehouses={warehouses}
          selectedGroupId={selectedGroupId}
          onSelectGroup={setSelectedGroupId}
          issueMessagesByGroup={issueMessagesByGroup}
          draftId={draftId}
          onSaveDraft={handleSaveDraft}
          savingDraft={saveMutation.isPending}
        />
      )}

      {step === "review" && draftId !== null && (
        <ReviewStep
          draftId={draftId}
          analysis={serverAnalysis}
          groups={groups}
          savedRows={draftRows}
          pricingBasis={pricingBasis}
          rateBook={selectedBook}
          serviceLevel={selectedLevel}
          activeTable={activeTable}
          onJumpToGroup={(groupId) => {
            setStep("rates");
            setSelectedGroupId(groupId);
          }}
          onActivated={() => {
            invalidateShippingAdmin(queryClient);
            onExit();
          }}
        />
      )}
      {step === "review" && draftId === null && (
        <div className="flex items-center gap-2 rounded-md border p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Saving the draft before review…
        </div>
      )}

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3 md:px-6">
          <div className="flex items-center gap-2 text-sm">
            {validation.errors.length > 0 ? (
              <span className="flex items-center gap-1.5 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {validation.errors.length} issue{validation.errors.length === 1 ? "" : "s"} to resolve before activation
              </span>
            ) : groups.length > 0 ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                {draftRows.length.toLocaleString()} rate row{draftRows.length === 1 ? "" : "s"} ready
              </span>
            ) : (
              <span className="text-muted-foreground">Drafts never affect live quotes.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={handleExit}>Cancel</Button>
            {step !== "context" && (
              <Button
                variant="outline"
                onClick={handleSaveDraft}
                disabled={saveMutation.isPending || !contextComplete}
              >
                {saveMutation.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Save className="mr-2 h-4 w-4" />}
                Save draft
              </Button>
            )}
            {step === "context" && (
              <Button onClick={() => setStep("rates")} disabled={!contextComplete}>
                Continue
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
            {step === "rates" && (
              <Button onClick={handleReview} disabled={saveMutation.isPending || !contextComplete}>
                Review
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
            {step === "review" && (
              <Button variant="outline" onClick={() => setStep("rates")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to editing
              </Button>
            )}
          </div>
        </div>
      </div>

      <CsvImportDialog
        open={csvOpen}
        onOpenChange={setCsvOpen}
        pricingBasis={pricingBasis}
        editorHasContent={groups.some((group) =>
          group.regions.length > 0 || group.zipEntries.length > 0
          || group.bands.some((band) => band.rateUsd.trim() !== ""))}
        onLoad={(parsed) => {
          const loaded = groupsFromRows(parsed.rows, pricingBasis);
          updateGroups(loaded);
          setSelectedGroupId(loaded[0]?.id ?? null);
          setStep("rates");
          toast({
            title: "CSV loaded into the editor",
            description: `${loaded.length} destination group${loaded.length === 1 ? "" : "s"} created. Review, then save the draft.`,
          });
        }}
      />

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Save the draft to keep them, or discard and leave —
              live quoting is unaffected either way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmDiscard(false);
                saveMutation.mutate(undefined, {
                  onSuccess: () => {
                    toast({ title: "Draft saved" });
                    onExit();
                  },
                });
              }}
              disabled={!contextComplete || saveMutation.isPending}
            >
              Save and leave
            </Button>
            <AlertDialogAction
              onClick={() => {
                setConfirmDiscard(false);
                onExit();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Context
// ---------------------------------------------------------------------------

interface ContextStepProps {
  rateBooks: RateBookSummary[];
  serviceLevels: ServiceLevelOption[];
  rateBookCode: string;
  serviceLevelCode: string;
  lockProgram: boolean;
  onSelectBook: (code: string) => void;
  onSelectLevel: (code: string) => void;
}

function ContextStep({
  rateBooks,
  serviceLevels,
  rateBookCode,
  serviceLevelCode,
  lockProgram,
  onSelectBook,
  onSelectLevel,
}: ContextStepProps) {
  const selectedBook = rateBooks.find((book) => book.code === rateBookCode) ?? null;
  const selectableBooks = rateBooks.filter((book) => book.status !== "retired");

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1.5">
        <Label>Pricing program</Label>
        {lockProgram && selectedBook ? (
          <div className="rounded-md border bg-muted/30 px-3 py-2.5">
            <div className="text-sm font-medium">{selectedBook.name}</div>
            <UsedByLine book={selectedBook} />
          </div>
        ) : (
          <Select value={rateBookCode} onValueChange={onSelectBook}>
            <SelectTrigger className="h-auto min-h-10 py-2">
              <SelectValue placeholder="Choose the program these prices belong to" />
            </SelectTrigger>
            <SelectContent>
              {selectableBooks.map((book) => (
                <SelectItem key={book.id} value={book.code} className="py-2">
                  <div>
                    <div className="font-medium">{book.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {book.assignments.filter((assignment) => assignment.isActive).length === 0
                        ? "Not used by any channel yet"
                        : book.assignments
                            .filter((assignment) => assignment.isActive)
                            .map(assignmentLabel)
                            .join(" · ")}
                    </div>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {!lockProgram && selectedBook && <UsedByLine book={selectedBook} />}
      </div>

      <div className="space-y-1.5">
        <Label>Shipping option</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {serviceLevels.map((level) => {
            const selected = level.code === serviceLevelCode;
            const configurable = level.isActive;
            return (
              <button
                key={level.id}
                type="button"
                disabled={!configurable}
                onClick={() => configurable && onSelectLevel(level.code)}
                aria-pressed={selected}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-left transition-colors",
                  selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50",
                  !configurable && "cursor-not-allowed bg-muted/20 opacity-70 hover:bg-muted/20",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{level.displayName}</span>
                  <span className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {level.fulfillmentMode === "freight" ? "Freight" : "Parcel"}
                    </Badge>
                    {!configurable && (
                      <Badge variant="secondary" className="text-[10px]">Future</Badge>
                    )}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {level.fulfillmentMode === "freight"
                    ? "Priced by pallet count"
                    : "Priced by total shipment weight"}
                  {level.promiseMinBusinessDays !== null && level.promiseMaxBusinessDays !== null && (
                    <> · {level.promiseMinBusinessDays === level.promiseMaxBusinessDays
                      ? `${level.promiseMinBusinessDays} business day${level.promiseMinBusinessDays === 1 ? "" : "s"}`
                      : `${level.promiseMinBusinessDays}–${level.promiseMaxBusinessDays} business days`}</>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        {serviceLevels.some((level) => !level.isActive) && (
          <p className="flex items-start gap-1.5 text-xs text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Future options become configurable after their fulfillment methods are mapped.
          </p>
        )}
      </div>

      <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        Currency is USD. A new draft has no effect on live quoting — you will review coverage
        and changes before anything activates.
      </div>
    </div>
  );
}

function UsedByLine({ book }: { book: RateBookSummary }) {
  const active = book.assignments.filter((assignment) => assignment.isActive);
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {active.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          Not used by any channel yet — rates can be prepared and assigned later.
        </span>
      ) : (
        active.map((assignment) => (
          <Badge key={assignment.id} variant="outline" className="font-normal">
            {assignmentLabel(assignment)}
          </Badge>
        ))
      )}
    </div>
  );
}
