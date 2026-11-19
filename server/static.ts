import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { applyOpsPortalBranding, isOpsPortalHost } from "./ops-portal-branding";

export function serveStatic(app: Express, distPath = path.resolve(__dirname, "public")) {
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Both variants are built once at startup; a template that no longer
  // matches the .ops branding tags fails the boot instead of a request.
  const indexHtml = fs.readFileSync(path.resolve(distPath, "index.html"), "utf-8");
  const opsPortalIndexHtml = applyOpsPortalBranding(indexHtml);

  // index: false so "/" falls through to the host-aware handler below instead
  // of express.static answering it with the unbranded index.html.
  app.use(express.static(distPath, { index: false }));

  // fall through to index.html if the file doesn't exist
  app.use("*", (req, res) => {
    res.type("html").send(isOpsPortalHost(req.hostname) ? opsPortalIndexHtml : indexHtml);
  });
}
