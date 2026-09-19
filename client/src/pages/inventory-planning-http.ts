import { z } from "zod";

export async function fetchJson<Schema extends z.ZodTypeAny>(
  url: string,
  schema: Schema,
  init?: RequestInit,
): Promise<z.output<Schema>> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const serverError = parseServerError(body);
    throw new HttpResponseError(
      response.status,
      serverError?.code ?? null,
      serverError?.message ?? `Request failed (${response.status}).`,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "response";
    throw new Error(
      `Server returned invalid data at ${path}: ${issue?.message ?? "invalid response"}.`,
    );
  }
  return parsed.data;
}

export class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

function parseServerError(body: unknown): { code: string | null; message: string } | null {
  const parsed = z.object({
    error: z.union([
      z.string(),
      z.object({
        code: z.string().optional(),
        message: z.string().optional(),
        details: z.array(z.string()).optional(),
      }).passthrough(),
    ]),
  }).passthrough().safeParse(body);
  if (!parsed.success) return null;
  if (typeof parsed.data.error === "string") {
    return { code: null, message: parsed.data.error };
  }
  const message = parsed.data.error.details?.[0] ?? parsed.data.error.message;
  return message ? { code: parsed.data.error.code ?? null, message } : null;
}
