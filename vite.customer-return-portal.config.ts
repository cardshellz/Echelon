import { defineConfig, mergeConfig } from "vite";
import path from "node:path";
import account from "./vite.customer-account.config";

// Reuse the established scoped CSS build, with separate assets so publishing the
// returns page cannot replace the live account bundle or its source revision.
export default mergeConfig(account, defineConfig({ build: {
  outDir: "dist/customer-return-portal",
  lib: { entry: path.resolve(import.meta.dirname, "client/src/customer-account/return-portal.entry.tsx"),
    name: "CardshellzReturnPortal", formats: ["iife"],
    fileName: () => "csz-return-portal.js", cssFileName: "csz-return-portal" },
} }));
