/**
 * Pricing Programs (spec §7.1): the program-centric entry point for all
 * shipping-rate work. Overview → program detail → full-page draft editor /
 * read-only revision viewer, as an in-tab state machine.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { groupsFromLayout, groupsFromRows } from "../rate-table-model";
import {
  RATE_TABLES_KEY,
  assignmentLabel,
  buildProgramOverviews,
  channelLabel,
  formatDate,
  getJson,
  postJson,
  rateTableDetailKey,
  type ProgramOverview,
  type RateTableDetail,
  type RateTablesResponse,
  type WarehouseOption,
} from "./api";
import { ProgramDetail } from "./ProgramDetail";
import { ProgramFormDialog } from "./ProgramFormDialog";
import { RateTableEditor, type EditorLaunch } from "./RateTableEditor";
import { RevisionViewer } from "./RevisionViewer";
import { programStatusBadge } from "./status";

type View =
  | { kind: "overview" }
  | { kind: "program"; bookId: number }
  | { kind: "editor"; launch: EditorLaunch; returnTo: View }
  | { kind: "revision"; tableId: number; returnTo: View };

export function PricingProgramsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ kind: "overview" });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [channelFilter, setChannelFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [preparingEditor, setPreparingEditor] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery<RateTablesResponse>({
    queryKey: [RATE_TABLES_KEY],
    queryFn: () => getJson<RateTablesResponse>(RATE_TABLES_KEY),
  });
  const { data: warehouses = [] } = useQuery<WarehouseOption[]>({
    queryKey: ["/api/warehouses"],
    queryFn: () => getJson<WarehouseOption[]>("/api/warehouses"),
  });

  const initialRolloutData = useMemo<RateTablesResponse | undefined>(() => {
    if (!data) return undefined;
    return {
      ...data,
      serviceLevels: data.serviceLevels.filter((level) => level.code === "standard"),
    };
  }, [data]);

  const programs = useMemo(
    () => initialRolloutData ? buildProgramOverviews(initialRolloutData) : [],
    [initialRolloutData],
  );

  const filteredPrograms = useMemo(() => {
    const text = search.trim().toLowerCase();
    return programs.filter((program) => {
      if (statusFilter !== "all" && program.book.status !== statusFilter) return false;
      if (channelFilter !== "all") {
        const channels = program.activeAssignments.map((assignment) => assignment.pricingChannel);
        if (channelFilter === "unassigned" ? channels.length > 0 : !channels.includes(channelFilter)) {
          return false;
        }
      }
      if (text === "") return true;
      return program.book.name.toLowerCase().includes(text)
        || program.book.code.toLowerCase().includes(text);
    });
  }, [programs, search, statusFilter, channelFilter]);

  /** Resume an existing draft in the editor with its exact saved layout. */
  const openDraft = async (draftId: number, returnTo: View) => {
    setPreparingEditor(true);
    try {
      const detail = await queryClient.fetchQuery<RateTableDetail>({
        queryKey: [rateTableDetailKey(draftId)],
        queryFn: () => getJson<RateTableDetail>(rateTableDetailKey(draftId)),
      });
      const groups = groupsFromLayout(detail.rateTable.metadata)
        ?? groupsFromRows(detail.rows, detail.rateTable.pricingBasis);
      setView({
        kind: "editor",
        returnTo,
        launch: {
          draftId,
          rateBookCode: detail.rateBook?.code ?? null,
          serviceLevelCode: detail.serviceLevel?.code ?? null,
          groups,
          lockProgram: true,
        },
      });
    } catch (error) {
      toast({
        title: "Could not open the draft",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPreparingEditor(false);
    }
  };

  /** Clone a non-draft revision into a fresh editable draft, then open it. */
  const createRevision = async (sourceTableId: number, returnTo: View) => {
    setPreparingEditor(true);
    try {
      const cloned = await postJson<{ rateTable: { id: number } }>(
        `/api/shipping/admin/rate-tables/${sourceTableId}/clone`,
        {},
      );
      queryClient.invalidateQueries({ queryKey: [RATE_TABLES_KEY] });
      await openDraft(cloned.rateTable.id, returnTo);
    } catch (error) {
      toast({
        title: "Could not create a revision",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
      setPreparingEditor(false);
    }
  };

  if (preparingEditor) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 p-16 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Opening the editor…
        </CardContent>
      </Card>
    );
  }

  if (view.kind === "editor" && initialRolloutData) {
    return (
      <RateTableEditor
        launch={view.launch}
        rateBooks={initialRolloutData.rateBooks}
        serviceLevels={initialRolloutData.serviceLevels}
        warehouses={warehouses}
        rateTables={initialRolloutData.rateTables}
        onExit={() => setView(view.returnTo)}
      />
    );
  }

  if (view.kind === "revision") {
    return (
      <RevisionViewer
        tableId={view.tableId}
        onBack={() => setView(view.returnTo)}
        onCreateRevision={(sourceId) => createRevision(sourceId, view.returnTo)}
        onContinueDraft={(draftId) => openDraft(draftId, view.returnTo)}
      />
    );
  }

  if (view.kind === "program") {
    const program = programs.find((item) => item.book.id === view.bookId);
    if (isLoading) return <ProgramsSkeleton />;
    if (!program) {
      // Deleted or filtered away server-side; fall back to the overview.
      return (
        <OverviewBody
          programs={filteredPrograms}
          allCount={programs.length}
          isLoading={isLoading}
          isError={isError}
          refetch={() => refetch()}
          search={search}
          setSearch={setSearch}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          channelFilter={channelFilter}
          setChannelFilter={setChannelFilter}
          onCreate={() => setCreateOpen(true)}
          onOpenProgram={(bookId) => setView({ kind: "program", bookId })}
          createOpen={createOpen}
          setCreateOpen={setCreateOpen}
          warehouses={warehouses}
        />
      );
    }
    const here: View = { kind: "program", bookId: view.bookId };
    return (
      <ProgramDetail
        program={program}
        warehouses={warehouses}
        onBack={() => setView({ kind: "overview" })}
        onViewTable={(tableId) => setView({ kind: "revision", tableId, returnTo: here })}
        onContinueDraft={(draftId) => openDraft(draftId, here)}
        onCreateRevision={(sourceTableId) => createRevision(sourceTableId, here)}
        onStartRates={(serviceLevelCode) => setView({
          kind: "editor",
          returnTo: here,
          launch: {
            draftId: null,
            rateBookCode: program.book.code,
            serviceLevelCode,
            groups: null,
            lockProgram: true,
          },
        })}
      />
    );
  }

  return (
    <OverviewBody
      programs={filteredPrograms}
      allCount={programs.length}
      isLoading={isLoading}
      isError={isError}
      refetch={() => refetch()}
      search={search}
      setSearch={setSearch}
      statusFilter={statusFilter}
      setStatusFilter={setStatusFilter}
      channelFilter={channelFilter}
      setChannelFilter={setChannelFilter}
      onCreate={() => setCreateOpen(true)}
      onOpenProgram={(bookId) => setView({ kind: "program", bookId })}
      createOpen={createOpen}
      setCreateOpen={setCreateOpen}
      warehouses={warehouses}
    />
  );
}

interface OverviewBodyProps {
  programs: ProgramOverview[];
  allCount: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  search: string;
  setSearch: (value: string) => void;
  statusFilter: string;
  setStatusFilter: (value: string) => void;
  channelFilter: string;
  setChannelFilter: (value: string) => void;
  onCreate: () => void;
  onOpenProgram: (bookId: number) => void;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  warehouses: WarehouseOption[];
}

function OverviewBody(props: OverviewBodyProps) {
  return (
      <Card>
        <CardContent className="space-y-4 p-3 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold md:text-lg">
                <BookOpen className="h-5 w-5" />
                Pricing programs
              </h2>
              <p className="text-xs text-muted-foreground md:text-sm">
                What Card Shellz charges for shipping, per checkout or fulfillment flow.
              </p>
            </div>
            <Button onClick={props.onCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Create pricing program
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={props.search}
                onChange={(event) => props.setSearch(event.target.value)}
                placeholder="Search programs…"
                aria-label="Search pricing programs"
                className="h-9 pl-8"
              />
            </div>
            <Select value={props.statusFilter} onValueChange={props.setStatusFilter}>
              <SelectTrigger className="h-9 w-32" aria-label="Status filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="retired">Retired</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
              </SelectContent>
            </Select>
            <Select value={props.channelFilter} onValueChange={props.setChannelFilter}>
              <SelectTrigger className="h-9 w-40" aria-label="Channel filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
                <SelectItem value="internal">Internal website</SelectItem>
                <SelectItem value="dropship">Dropship</SelectItem>
                <SelectItem value="ebay">eBay</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {props.isLoading ? (
            <ProgramsSkeleton />
          ) : props.isError ? (
            <div className="rounded-md border border-destructive/40 p-8 text-center">
              <p className="text-sm text-destructive">Pricing programs could not be loaded.</p>
              <Button variant="outline" className="mt-3" onClick={props.refetch}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : props.allCount === 0 ? (
            <div className="rounded-md border border-dashed p-10 text-center">
              <BookOpen className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm font-medium">No pricing programs yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                A pricing program determines what a checkout or fulfillment flow charges for
                shipping. Create one, then add rates per shipping option.
              </p>
              <Button className="mt-4" onClick={props.onCreate}>
                <Plus className="mr-2 h-4 w-4" />
                Create pricing program
              </Button>
            </div>
          ) : props.programs.length === 0 ? (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No program matches these filters.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Program</TableHead>
                    <TableHead>Used by</TableHead>
                    <TableHead>Shipping options</TableHead>
                    <TableHead>Coverage</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-8"><span className="sr-only">Open</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {props.programs.map((program) => (
                    <ProgramRow
                      key={program.book.id}
                      program={program}
                      onOpen={() => props.onOpenProgram(program.book.id)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>

        <ProgramFormDialog
          open={props.createOpen}
          onOpenChange={props.setCreateOpen}
          warehouses={props.warehouses}
          onSaved={(bookId) => props.onOpenProgram(bookId)}
        />
      </Card>
  );
}

function ProgramRow({ program, onOpen }: { program: ProgramOverview; onOpen: () => void }) {
  const { book, options, activeAssignments } = program;
  const liveOptions = options.filter((option) => option.active !== null);
  return (
    <TableRow
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <TableCell>
        <div className="text-sm font-medium">{book.name}</div>
      </TableCell>
      <TableCell>
        <div className="flex max-w-64 flex-wrap gap-1">
          {activeAssignments.length === 0 ? (
            <span className="flex items-center gap-1 text-xs text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              Not assigned
            </span>
          ) : (
            activeAssignments.slice(0, 3).map((assignment) => (
              <Badge key={assignment.id} variant="outline" className="whitespace-nowrap font-normal">
                {assignmentLabel(assignment)}
              </Badge>
            ))
          )}
          {activeAssignments.length > 3 && (
            <Badge variant="outline" className="font-normal">
              +{activeAssignments.length - 3}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <TooltipProvider delayDuration={300}>
          <div className="flex flex-wrap gap-1">
            {options.map((option) => {
              const state = option.active
                ? "live"
                : option.draft
                  ? "draft"
                  : "none";
              return (
                <Tooltip key={option.serviceLevel.id}>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                        state === "live" && "border-emerald-300 bg-emerald-50 text-emerald-800",
                        state === "draft" && "border-amber-300 bg-amber-50 text-amber-800",
                        state === "none" && "border-muted text-muted-foreground",
                      )}
                    >
                      {option.serviceLevel.displayName}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {state === "live" && option.active && (
                      <>Live since {formatDate(option.active.effectiveFrom)} · {option.active.stateCount} states
                        {option.draft && " · draft in progress"}</>
                    )}
                    {state === "draft" && "Draft in progress — not quoting yet"}
                    {state === "none" && "No rates configured"}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {liveOptions.length === 0
          ? "No live rates"
          : `${program.maxLiveStateCount} states · ${program.totalZipOverrides} ZIP overrides`}
      </TableCell>
      <TableCell>{programStatusBadge(book.status)}</TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDate(program.lastTouched)}
      </TableCell>
      <TableCell>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </TableCell>
    </TableRow>
  );
}

function ProgramsSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-4 rounded-md border p-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-72" />
          </div>
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}
