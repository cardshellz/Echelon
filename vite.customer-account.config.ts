import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import postcss from "postcss";
import path from "node:path";

// Scope the reused UI's compiled styles to its portal root. Shopify themes use
// their own resets and root font sizes; rem values become px to preserve the
// editor's layout without changing the storefront's typography or global CSS.
export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [react(), tailwindcss(), {
    name: "customer-account-scoped-css",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== "asset" || !asset.fileName.endsWith(".css") || typeof asset.source !== "string") continue;
        const css = postcss.parse(asset.source);
        css.walkRules(rule => {
          if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
          rule.selectors = rule.selectors.map(selector => selector.includes(".csz-account-") || selector.includes(".csz-dialog-") || selector.includes(".csz-modal-")
            ? selector : /^(:root|:host|html|body)$/.test(selector) ? ".csz-account-ui" : `.csz-account-ui ${selector}`);
        });
        css.walkDecls(declaration => { declaration.value = declaration.value.replace(/(-?\d*\.?\d+)rem\b/g, (_match, value: string) => `${Number(value) * 16}px`); });
        asset.source = css.toString();
      }
    },
  }],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "client/src"), "@shared": path.resolve(import.meta.dirname, "shared") } },
  css: { postcss: { plugins: [] } },
  build: { outDir: "dist/customer-account", emptyOutDir: true, cssCodeSplit: false,
    lib: { entry: path.resolve(import.meta.dirname, "client/src/customer-account/entry.tsx"), name: "CardshellzCustomerAccount", formats: ["iife"], fileName: () => "csz-customer-account.js", cssFileName: "csz-customer-account" } },
});
