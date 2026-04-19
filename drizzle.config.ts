import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!.includes("amazonaws.com") && !process.env.DATABASE_URL!.includes("sslmode=")
      ? `${process.env.DATABASE_URL}?sslmode=require`
      : process.env.DATABASE_URL!,
    ssl: process.env.DATABASE_URL!.includes("amazonaws.com") || process.env.EXTERNAL_DATABASE_URL ? true : false,
  },
});
