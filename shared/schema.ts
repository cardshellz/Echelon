// Re-export from split schema modules for backward compatibility
// New code should import from "@shared/schema" (resolves to shared/schema/index.ts)
// or directly from the domain schema file (e.g., "@shared/schema/inventory.schema")
export * from "./schema/index";
