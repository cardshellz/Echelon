import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  marketplaceChannelListingScopes,
  marketplaceDropshipListingScopes,
  marketplaceListingActorTypeEnum,
  marketplaceListingMemberDispositionEnum,
  marketplaceListingPublicationMembers,
  marketplaceListingPublications,
  marketplaceListingPublicationStatusEnum,
  marketplaceListingReplacementEvents,
  marketplaceListingReplacementOperations,
  marketplaceListingReplacementPhaseEnum,
  marketplaceListingReplacementStatusEnum,
  marketplaceListingReplacementSteps,
  marketplaceListingReplacementStepStatusEnum,
  marketplaceListingScopes,
} from "../../../../../shared/schema/marketplace-listings.schema";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0607_marketplace_listing_replacement_foundation.sql",
  ),
  "utf8",
);

interface TableContract {
  readonly name: string;
  readonly table: PgTable;
}

const tableContracts: readonly TableContract[] = [
  { name: "listing_scopes", table: marketplaceListingScopes },
  { name: "channel_listing_scopes", table: marketplaceChannelListingScopes },
  { name: "dropship_listing_scopes", table: marketplaceDropshipListingScopes },
  { name: "listing_publications", table: marketplaceListingPublications },
  {
    name: "listing_publication_members",
    table: marketplaceListingPublicationMembers,
  },
  {
    name: "listing_replacement_operations",
    table: marketplaceListingReplacementOperations,
  },
  {
    name: "listing_replacement_steps",
    table: marketplaceListingReplacementSteps,
  },
  {
    name: "listing_replacement_events",
    table: marketplaceListingReplacementEvents,
  },
] as const;

function extractCreateTableBody(schemaName: string, tableName: string): string {
  const header = `CREATE TABLE ${schemaName}.${tableName} (`;
  const headerIndex = migrationSql.indexOf(header);
  if (headerIndex < 0) {
    throw new Error(`Migration is missing ${schemaName}.${tableName}`);
  }

  const bodyStart = headerIndex + header.length;
  let depth = 1;
  let insideString = false;

  for (let index = bodyStart; index < migrationSql.length; index += 1) {
    const character = migrationSql[index];
    const nextCharacter = migrationSql[index + 1];

    if (character === "'") {
      if (insideString && nextCharacter === "'") {
        index += 1;
        continue;
      }
      insideString = !insideString;
      continue;
    }
    if (insideString) {
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return migrationSql.slice(bodyStart, index);
      }
    }
  }

  throw new Error(
    `Migration has an unterminated definition for ${schemaName}.${tableName}`,
  );
}

function splitTopLevelCommaSeparated(source: string): string[] {
  const parts: string[] = [];
  let partStart = 0;
  let depth = 0;
  let insideString = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (character === "'") {
      if (insideString && nextCharacter === "'") {
        index += 1;
        continue;
      }
      insideString = !insideString;
      continue;
    }
    if (insideString) {
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 0) {
      parts.push(source.slice(partStart, index).trim());
      partStart = index + 1;
    }
  }

  parts.push(source.slice(partStart).trim());
  return parts.filter((part) => part.length > 0);
}

function extractColumnDefinitions(
  tableBody: string,
): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();

  for (const part of splitTopLevelCommaSeparated(tableBody)) {
    if (/^CONSTRAINT\b/i.test(part)) {
      continue;
    }
    const match = part.match(/^([a-z_][a-z0-9_]*)\s+([\s\S]+)$/i);
    if (!match) {
      throw new Error(`Could not parse migration table member: ${part}`);
    }
    definitions.set(match[1], match[2]);
  }

  return definitions;
}

function sqlColumnIsNotNull(definition: string): boolean {
  return (
    /\bNOT\s+NULL\b/i.test(definition) || /\bPRIMARY\s+KEY\b/i.test(definition)
  );
}

function sqlColumnHasDefault(definition: string): boolean {
  return (
    /\bDEFAULT\b/i.test(definition) ||
    /\bGENERATED\s+ALWAYS\s+AS\s+IDENTITY\b/i.test(definition)
  );
}

function compactSql(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

describe("marketplace listing replacement schema parity", () => {
  for (const contract of tableContracts) {
    it(`keeps marketplace.${contract.name} columns aligned with migration 0607`, () => {
      const config = getTableConfig(contract.table);
      expect(config.schema).toBe("marketplace");
      expect(config.name).toBe(contract.name);

      const sqlColumns = extractColumnDefinitions(
        extractCreateTableBody("marketplace", contract.name),
      );
      const drizzleColumnNames = config.columns
        .map((column) => column.name)
        .sort();
      expect([...sqlColumns.keys()].sort()).toEqual(drizzleColumnNames);

      for (const column of config.columns) {
        const sqlDefinition = sqlColumns.get(column.name);
        if (!sqlDefinition) {
          throw new Error(
            `Migration is missing marketplace.${contract.name}.${column.name}`,
          );
        }

        expect(
          {
            hasDefault: column.hasDefault,
            notNull: column.notNull,
          },
          `Drizzle flags differ for marketplace.${contract.name}.${column.name}`,
        ).toEqual({
          hasDefault: sqlColumnHasDefault(sqlDefinition),
          notNull: sqlColumnIsNotNull(sqlDefinition),
        });
      }
    });
  }

  it("keeps lifecycle vocabulary aligned between Drizzle and database checks", () => {
    expect(marketplaceListingPublicationStatusEnum).toEqual([
      "planned",
      "staged",
      "active",
      "superseded",
      "withdrawn",
      "failed",
    ]);
    expect(marketplaceListingMemberDispositionEnum).toEqual([
      "included",
      "excluded",
    ]);
    expect(marketplaceListingReplacementStatusEnum).toEqual([
      "planned",
      "running",
      "compensating",
      "completed",
      "failed",
      "manual_recovery_required",
      "cancelled",
    ]);
    expect(marketplaceListingReplacementPhaseEnum).toEqual([
      "preflight",
      "cutover",
      "publish",
      "verify",
      "switch_mapping",
      "compensate",
      "complete",
    ]);
    expect(marketplaceListingReplacementStepStatusEnum).toEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
    ]);
    expect(marketplaceListingActorTypeEnum).toEqual([
      "user",
      "service",
      "system",
    ]);

    const compactMigration = compactSql(migrationSql);
    expect(compactMigration).toContain(
      "status IN ('planned', 'staged', 'active', 'superseded', 'withdrawn', 'failed')",
    );
    expect(compactMigration).toContain(
      "disposition IN ('included', 'excluded')",
    );
    expect(compactMigration).toContain(
      "'planned', 'running', 'compensating', 'completed', 'failed', 'manual_recovery_required', 'cancelled'",
    );
    expect(compactMigration).toContain(
      "'preflight', 'cutover', 'publish', 'verify', 'switch_mapping', 'compensate', 'complete'",
    );
    expect(compactMigration).toContain(
      "status IN ('pending', 'running', 'succeeded', 'failed')",
    );
    expect(compactMigration).toContain(
      "created_by_type IN ('user', 'service', 'system')",
    );
    expect(compactMigration).toContain(
      "requested_by_type IN ('user', 'service', 'system')",
    );
    expect(compactMigration).toContain(
      "actor_type IN ('user', 'service', 'system')",
    );
  });
});
