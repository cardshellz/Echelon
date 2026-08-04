import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
import {
  discardRateTableDraft,
  invalidateShippingAdmin,
} from "./api";

interface DiscardRateTableDraftButtonProps {
  draftId: number;
  onDiscarded?: () => void;
  size?: "default" | "sm";
  label?: string;
}

export function DiscardRateTableDraftButton({
  draftId,
  onDiscarded,
  size = "default",
  label = "Discard draft",
}: DiscardRateTableDraftButtonProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const discardMutation = useMutation({
    mutationFn: () => discardRateTableDraft(draftId),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      toast({
        title: "Draft discarded",
        description: "The saved draft was removed. Live rates were not changed.",
      });
      setOpen(false);
      onDiscarded?.();
    },
    onError: (error: Error) => {
      toast({
        title: "Could not discard the draft",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={size}
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this entire draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the saved working draft and all of its
              draft-only rates and rules. The active revision and revision
              history remain unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discardMutation.isPending}>
              Keep draft
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => discardMutation.mutate()}
              disabled={discardMutation.isPending}
            >
              {discardMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Discard draft
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
