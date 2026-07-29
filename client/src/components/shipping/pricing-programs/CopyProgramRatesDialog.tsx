import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2 } from "lucide-react";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  invalidateShippingAdmin,
  postIdempotentJson,
  rateCopySourceOptions,
  rateProgramCopyConflicts,
  type CopyRateProgramResponse,
  type ProgramOverview,
} from "./api";

export interface IdempotencyKeyFactory {
  create(): string;
}

const browserIdempotencyKeyFactory: IdempotencyKeyFactory = {
  create(): string {
    return `shipping-program-copy:${globalThis.crypto.randomUUID()}`;
  },
};

interface CopyProgramRatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetProgram: ProgramOverview;
  programs: ProgramOverview[];
  idempotencyKeyFactory?: IdempotencyKeyFactory;
}

export function CopyProgramRatesDialog({
  open,
  onOpenChange,
  targetProgram,
  programs,
  idempotencyKeyFactory = browserIdempotencyKeyFactory,
}: CopyProgramRatesDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sourceId, setSourceId] = useState("");
  const commandKey = useRef<string | null>(null);
  const sources = useMemo(
    () => rateCopySourceOptions(programs, targetProgram.book.id),
    [programs, targetProgram.book.id],
  );
  const source = sources.find(
    (candidate) => candidate.book.id === Number(sourceId),
  ) ?? null;
  const conflicts = source === null
    ? []
    : rateProgramCopyConflicts(targetProgram);
  const liveOptions = source?.options.filter(
    (option) => option.active !== null,
  ) ?? [];

  useEffect(() => {
    if (!open) return;
    setSourceId("");
    commandKey.current = null;
  }, [open, targetProgram.book.id]);

  const copyMutation = useMutation({
    mutationFn: async () => {
      if (source === null) {
        throw new Error("Choose a source pricing program.");
      }
      const idempotencyKey = commandKey.current
        ?? idempotencyKeyFactory.create();
      commandKey.current = idempotencyKey;
      return postIdempotentJson<CopyRateProgramResponse>(
        `/api/shipping/admin/rate-books/${targetProgram.book.id}/copy-rates`,
        { sourceRateBookId: source.book.id },
        idempotencyKey,
      );
    },
    onSuccess: (result) => {
      invalidateShippingAdmin(queryClient);
      commandKey.current = null;
      onOpenChange(false);
      toast({
        title: "Rates copied as drafts",
        description:
          `${result.createdDrafts.length} shipping option`
          + `${result.createdDrafts.length === 1 ? "" : "s"} copied. Review and activate when ready.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not copy the rates",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const selectSource = (value: string) => {
    commandKey.current = null;
    setSourceId(value);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy rates into {targetProgram.book.name}</DialogTitle>
          <DialogDescription>
            Copy another program&apos;s live rates into this program as drafts.
            Assignments and current live rates do not change.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="copy-rate-source">Copy from</Label>
            <Select value={sourceId} onValueChange={selectSource}>
              <SelectTrigger id="copy-rate-source">
                <SelectValue placeholder="Choose a pricing program" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((candidate) => (
                  <SelectItem
                    key={candidate.book.id}
                    value={String(candidate.book.id)}
                  >
                    {candidate.book.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sources.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No other active pricing program has live rates to copy.
              </p>
            )}
          </div>

          {source !== null && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Shipping options copied</p>
              <div className="flex flex-wrap gap-1.5">
                {liveOptions.map((option) => (
                  <Badge key={option.serviceLevel.id} variant="outline">
                    {option.serviceLevel.displayName}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Destination groups, rate rows, product exceptions, and
                restrictions are included.
              </p>
            </div>
          )}

          {conflicts.length > 0 && (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
            >
              This target already has {conflicts.join(", ")} rates. Choose an
              empty pricing program.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={copyMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => copyMutation.mutate()}
            disabled={
              source === null
              || conflicts.length > 0
              || copyMutation.isPending
            }
          >
            {copyMutation.isPending
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Copy className="mr-2 h-4 w-4" />}
            Copy as drafts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
