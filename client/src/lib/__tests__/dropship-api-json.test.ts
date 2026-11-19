import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DROPSHIP_SITE_UPDATING_CODE,
  DROPSHIP_SITE_UPDATING_MESSAGE,
  DropshipApiError,
  isDropshipSiteUpdatingError,
  readDropshipAnswer,
  readDropshipJson,
} from "../dropship-ops-surface";

/**
 * "Site updating" for the requests stages 2-5 add (step 1 plan S2-5 §4.9 item 3,
 * D38, CHK7): an older server answers a route it does not know with the app's
 * HTML and 200 (server/static.ts), and an existing route it knows without a
 * field the newer page requires. Both read as the transient
 * DROPSHIP_SITE_UPDATING, so the page retries the same request; JSON answers
 * and JSON errors read as before.
 */
function answer(body: string, init: { status?: number; contentType?: string | null } = {}): Response {
  const headers = new Headers();
  if (init.contentType !== null) headers.set("content-type", init.contentType ?? "application/json; charset=utf-8");
  return new Response(body, { status: init.status ?? 200, headers });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (error: unknown) => error);
}

describe("readDropshipJson", () => {
  it("reads a JSON answer", async () => {
    await expect(readDropshipJson(answer(JSON.stringify({ run: { id: 1 } })))).resolves.toEqual({ run: { id: 1 } });
    await expect(readDropshipJson(answer("{}", { contentType: "application/problem+json" }))).resolves.toEqual({});
    await expect(readDropshipJson(answer("[]", { contentType: "Application/JSON" }))).resolves.toEqual([]);
  });

  it.each([
    ["the app's HTML with 200 (an older dyno's fallback)", answer("<!doctype html><html></html>", { contentType: "text/html; charset=UTF-8" })],
    ["HTML with a server error status", answer("<html>Application error</html>", { status: 503, contentType: "text/html" })],
    ["no content type", answer("{}", { contentType: null })],
    ["plain text", answer("Payload Too Large", { status: 413, contentType: "text/plain" })],
  ])("turns %s into the transient DROPSHIP_SITE_UPDATING", async (_label, response) => {
    const error = await caught(readDropshipJson(response));
    expect(error).toBeInstanceOf(DropshipApiError);
    expect(error).toMatchObject({
      status: 503,
      code: DROPSHIP_SITE_UPDATING_CODE,
      message: DROPSHIP_SITE_UPDATING_MESSAGE,
      context: { reason: "not_json", answerStatus: response.status },
    });
    expect(isDropshipSiteUpdatingError(error)).toBe(true);
  });

  it("keeps JSON errors exactly as the existing helpers read them", async () => {
    const error = await caught(readDropshipJson(answer(JSON.stringify({
      error: { code: "DROPSHIP_LISTING_PUSH_RUN_BUSY", message: "Your choices are being saved.", context: { runId: 4 } },
    }), { status: 409 })));
    expect(error).toMatchObject({
      status: 409, code: "DROPSHIP_LISTING_PUSH_RUN_BUSY", message: "Your choices are being saved.", context: { runId: 4 },
    });
    expect(isDropshipSiteUpdatingError(error)).toBe(false);
  });

  it("carries the PROPOSED siteUpdating words (§4.11)", () => {
    expect(DROPSHIP_SITE_UPDATING_MESSAGE).toBe(
      "Card Shellz is updating the site. This page will try again in a moment; nothing you did is lost.",
    );
  });
});

describe("readDropshipAnswer", () => {
  const summarySchema = z.object({ rows: z.array(z.unknown()), summary: z.object({ matching: z.number() }) });

  it("returns the parsed answer", async () => {
    await expect(readDropshipAnswer(answer(JSON.stringify({ rows: [], summary: { matching: 3 } })), summarySchema))
      .resolves.toEqual({ rows: [], summary: { matching: 3 } });
  });

  it("classes an older server's answer without a required field as site updating (CHK7)", async () => {
    // A stage 1 dyno ignores `selection=` and answers without `summary`.
    const error = await caught(readDropshipAnswer(answer(JSON.stringify({ rows: [] })), summarySchema));
    expect(error).toMatchObject({ status: 503, code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "answer_shape", answerStatus: 200 } });
  });

  it("keeps the HTML and JSON error cases of readDropshipJson", async () => {
    expect(await caught(readDropshipAnswer(answer("<html></html>", { contentType: "text/html" }), summarySchema)))
      .toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "not_json" } });
    expect(await caught(readDropshipAnswer(answer(JSON.stringify({ error: { code: "X", message: "m" } }), { status: 400 }), summarySchema)))
      .toMatchObject({ status: 400, code: "X" });
  });
});
