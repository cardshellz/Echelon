import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "@": path.resolve(__dirname, "./client/src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist", "build"],
    testTimeout: 30000,
    hookTimeout: 300000, // 5 min for migration runs against remote DB
    pool: "forks",
    // Separate projects for unit vs integration
    typecheck: {
      enabled: false, // We run tsc separately
    },
  },
});
