import { defineConfig } from "vite";
import path from "node:path";
export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client/src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  build: {
    outDir: "dist/customer-account",
    emptyOutDir: false,
    lib: {
      entry: path.resolve(
        import.meta.dirname,
        "client/src/customer-account/preload-entry.ts",
      ),
      name: "CardshellzAccountPreload",
      formats: ["iife"],
      fileName: () => "csz-account-preload.js",
    },
  },
});
