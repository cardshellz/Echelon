import { describe, expect, it } from "vitest";

import {
  readBoundedResponseText,
  ShipStationTrackingResponseReadError,
} from "../../shipstation-tracking-http";

describe("ShipStation tracking HTTP response reader", () => {
  it("returns a bounded UTF-8 response body", async () => {
    const response = new Response("carrier accepted");

    await expect(readBoundedResponseText(response, 100)).resolves.toBe("carrier accepted");
  });

  it("rejects an oversized declared content length before consuming the stream", async () => {
    const response = new Response("small", {
      headers: { "content-length": "1000" },
    });

    await expect(readBoundedResponseText(response, 100)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      responseBytes: 1000,
      maxResponseBytes: 100,
    });
  });

  it("rejects a streamed body once its actual bytes exceed the limit", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
        controller.close();
      },
    }));

    await expect(readBoundedResponseText(response, 6)).rejects.toBeInstanceOf(
      ShipStationTrackingResponseReadError,
    );
  });
});
