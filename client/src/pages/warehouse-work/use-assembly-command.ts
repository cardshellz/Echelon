import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { AssemblyRequestError, assemblyRequest, prepareAssemblyAttempt, type AssemblyAttempt } from "./assembly-api";

export function useAssemblyCommand<T>(schema: z.ZodType<T>, onSuccess?: (value: T) => void | Promise<void>) {
  const client = useQueryClient();
  const attempt = useRef<AssemblyAttempt | null>(null);
  const mutation = useMutation({
    retry: false,
    mutationFn: async (intent: { url: string; body: Record<string, unknown> } | null) => {
      if (intent) attempt.current = prepareAssemblyAttempt(intent.url, intent.body, attempt.current, () => crypto.randomUUID());
      if (!attempt.current) throw new Error("There is no pending work request to retry");
      return assemblyRequest(attempt.current.url, schema, attempt.current.body);
    },
    onSuccess: async (value) => {
      attempt.current = null;
      await Promise.all([client.invalidateQueries({ queryKey: ["assembly"] }), client.invalidateQueries({ queryKey: ["picking-queue"] })]);
      await onSuccess?.(value);
    },
    onError: (error) => { if (error instanceof AssemblyRequestError && !error.uncertain) attempt.current = null; },
  });
  return { ...mutation, retryOriginal: () => mutation.mutate(null), uncertain: mutation.isError && attempt.current !== null };
}
