import { describe, expect, it, vi } from "vitest";
import { downloadCustomerReturnLabel } from "../../infrastructure/customer-return-label-download";
const url = "https://api.shipstation.com/v2/downloads/one/label.pdf";
describe("private label PDF download", () => {
  it("downloads an allowlisted PDF without forwarding credentials or following redirects", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response("%PDF-1.4 test", {
          headers: { "content-type": "application/pdf" },
        }),
    );
    expect(
      Buffer.from(await downloadCustomerReturnLabel(url, request)).toString(),
    ).toBe("%PDF-1.4 test");
    expect(request).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "application/pdf" },
      }),
    );
  });
  it.each([
    "https://evil.example/label.pdf",
    "https://api.shipstation.com.evil.example/v2/downloads/label.pdf",
    "http://api.shipstation.com/v2/downloads/x",
    "https://api.shipstation.com/v2/labels/x",
  ])("rejects unsafe URL %s without network", async (unsafe) => {
    const request = vi.fn<typeof fetch>();
    await expect(
      downloadCustomerReturnLabel(unsafe, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    new Response("<html>error", {
      headers: { "content-type": "application/pdf" },
    }),
    new Response("%PDF-test", {
      headers: { "content-type": "application/json" },
    }),
    new Response("%PDF-test", {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(10 * 1024 * 1024 + 1),
      },
    }),
    new Response("%PDF-test", {
      status: 403,
      headers: { "content-type": "application/pdf" },
    }),
  ])("rejects invalid provider artifacts", async (response) => {
    await expect(
      downloadCustomerReturnLabel(
        url,
        vi.fn<typeof fetch>(async () => response),
      ),
    ).rejects.toMatchObject({ code: "RETURN_LABEL_DOWNLOAD_UNAVAILABLE" });
  });
});
