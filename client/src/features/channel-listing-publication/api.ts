import { z } from "zod";
import { apiRequest } from "@/lib/queryClient";

export async function publicationRequest<T>(
  method: string,
  url: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await apiRequest(method, url, input);
  } catch (error) {
    if (!(error instanceof Error))
      throw new Error("The channel request failed. Please try again.");
    const match = /^\d{3}: ([\s\S]+)$/.exec(error.message);
    if (match) {
      try {
        const body: unknown = JSON.parse(match[1]);
        if (body && typeof body === "object") {
          const record = body as Record<string, unknown>;
          const message =
            typeof record.message === "string"
              ? record.message
              : typeof record.error === "string"
                ? record.error
                : null;
          if (message) throw new PublicationRequestError(message);
        }
      } catch (parsed) {
        if (parsed instanceof PublicationRequestError) throw parsed;
      }
      throw new Error(
        "The channel request failed. Refresh its status and try again.",
      );
    }
    throw error;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "The server returned an unreadable channel response. Refresh and try again.",
    );
  }
  const result = schema.safeParse(body);
  if (!result.success)
    throw new Error(
      "The server returned an unexpected channel response. Refresh and try again.",
    );
  return result.data;
}

class PublicationRequestError extends Error {}
