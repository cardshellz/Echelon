import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOpsPortalBranding,
  indexHtmlForHost,
  isOpsPortalHost,
  OPS_PORTAL_TITLE,
  OpsPortalBrandingError,
} from "../../ops-portal-branding";
import { serveStatic } from "../../static";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, "client/index.html"), "utf-8");

describe("isOpsPortalHost", () => {
  it.each(["cardshellz.io", "www.cardshellz.io", "CardShellz.IO", " cardshellz.io "])("accepts %j", (host) => {
    expect(isOpsPortalHost(host)).toBe(true);
  });
  it.each([undefined, "", "cardshellz.com", "echelon.cardshellz.com", "cardshellz.io.evil.test", "localhost"])(
    "rejects %j",
    (host) => {
      expect(isOpsPortalHost(host)).toBe(false);
    },
  );
});

describe("applyOpsPortalBranding against the real client/index.html", () => {
  const branded = applyOpsPortalBranding(INDEX_HTML);

  it("swaps the icon, touch icon and manifest to the .ops set", () => {
    expect(branded).toContain(`<link rel="icon" type="image/svg+xml" href="/ops/favicon.svg" />`);
    expect(branded).toContain(`<link rel="icon" type="image/png" sizes="32x32" href="/ops/favicon-32.png" />`);
    expect(branded).toContain(`<link rel="apple-touch-icon" href="/ops/apple-touch-icon.png" />`);
    expect(branded).toContain(`<link rel="manifest" href="/ops/manifest.json" />`);
    expect(branded).not.toContain(`href="/favicon.png"`);
    expect(branded).not.toContain(`href="/manifest.json"`);
  });

  it("names the portal instead of Echelon", () => {
    expect(branded).toContain(`<title>${OPS_PORTAL_TITLE}</title>`);
    expect(branded).not.toMatch(/content="Echelon"/);
  });

  it("keeps the app entry script untouched", () => {
    expect(branded).toContain(`<script type="module" src="/src/main.tsx"></script>`);
  });

  it("does not mutate the input string", () => {
    expect(INDEX_HTML).toContain(`href="/favicon.png"`);
  });

  it("refuses a template whose tags no longer match instead of half-branding it", () => {
    const drifted = INDEX_HTML.replace(`<link rel="manifest" href="/manifest.json" />`, "");
    expect(() => applyOpsPortalBranding(drifted)).toThrow(OpsPortalBrandingError);
    const doubled = INDEX_HTML.replace("</head>", `<link rel="manifest" href="/manifest.json" />\n</head>`);
    expect(() => applyOpsPortalBranding(doubled)).toThrow(OpsPortalBrandingError);
  });
});

describe("indexHtmlForHost", () => {
  it("returns Echelon's HTML byte-for-byte on other hosts", () => {
    expect(indexHtmlForHost(INDEX_HTML, "echelon.example.com")).toBe(INDEX_HTML);
  });
  it("brands the portal host", () => {
    expect(indexHtmlForHost(INDEX_HTML, "cardshellz.io")).toContain("/ops/favicon.svg");
  });
});

describe("serveStatic", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let dist: string | undefined;
  afterEach(() => {
    server?.close();
    if (dist) fs.rmSync(dist, { recursive: true, force: true });
  });

  // fetch() treats Host as a forbidden header and silently drops it, so the
  // host-dependent requests go through node:http directly.
  function get(base: string, pathname: string, host: string): Promise<{ type: string; body: string }> {
    const { port } = new URL(base);
    return new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: pathname, headers: { host } }, (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ type: String(res.headers["content-type"]), body }));
      }).on("error", reject);
    });
  }

  async function start() {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "ops-branding-"));
    fs.writeFileSync(path.join(dist, "index.html"), INDEX_HTML);
    fs.writeFileSync(path.join(dist, "app.js"), "ok");
    const app = express();
    serveStatic(app, dist);
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it("serves the branded page at the root and deep links only on the portal host", async () => {
    const base = await start();
    for (const pathname of ["/", "/catalog/choose"]) {
      const portal = await get(base, pathname, "cardshellz.io");
      expect(portal.type).toContain("text/html");
      expect(portal.body).toContain("/ops/favicon.svg");
      const echelon = await get(base, pathname, "echelon.example.com");
      expect(echelon.body).toBe(INDEX_HTML);
    }
  });

  it("still serves real static files directly", async () => {
    const base = await start();
    expect(await (await fetch(`${base}/app.js`)).text()).toBe("ok");
  });

  it("fails at startup when the built template no longer matches", () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "ops-branding-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<html></html>");
    expect(() => serveStatic(express(), dist)).toThrow(OpsPortalBrandingError);
  });
});
