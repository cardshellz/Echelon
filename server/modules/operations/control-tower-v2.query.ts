import {
  CONTROL_TOWER_DOMAINS,
  CONTROL_TOWER_SEVERITIES,
  CONTROL_TOWER_VIEWS,
  type ControlTowerDomain,
  type ControlTowerSeverity,
  type ControlTowerView,
  type QueryClient,
} from "./control-tower-v2.domain";
import { CONTROL_TOWER_SOURCE_ADAPTERS } from "./control-tower-v2.sources";
import { ControlTowerRequestError } from "./control-tower-v2.request";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SOURCE_STALE_MINUTES = 20;

export interface ControlTowerQueueFilters {
  view: ControlTowerView;
  domain: ControlTowerDomain | "all";
  severity: ControlTowerSeverity | "all";
  ownerTeam: string | null;
  assignedUserId: string | null;
  search: string;
  limit: number;
  cursor: string | null;
}

interface QueueCursor {
  severityRank: number;
  sortAt: string;
  id: number;
}

interface GroupCursor {
  severityRank: number;
  sortAt: string;
  groupKey: string;
}

function singleQueryValue(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  if (value === null || value === undefined) return null;
  return String(value);
}

function boundedOptionalQuery(value: unknown, field: string, maxLength: number): string | null {
  const raw = singleQueryValue(value)?.trim() ?? "";
  if (!raw) return null;
  if (raw.length > maxLength) throw new ControlTowerRequestError(`${field} is too long`, 400, "INVALID_FILTER");
  return raw;
}

function parseLimit(value: unknown): number {
  const raw = singleQueryValue(value);
  if (!raw) return DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new ControlTowerRequestError(`limit must be between 1 and ${MAX_PAGE_SIZE}`, 400, "INVALID_LIMIT");
  }
  return parsed;
}

export function parseControlTowerV2QueueFilters(query: Record<string, unknown>): ControlTowerQueueFilters {
  const rawView = singleQueryValue(query.view) ?? "attention";
  const view = CONTROL_TOWER_VIEWS.includes(rawView as ControlTowerView)
    ? rawView as ControlTowerView
    : null;
  if (!view) throw new ControlTowerRequestError("Unsupported Control Tower view", 400, "INVALID_VIEW");

  const rawDomain = singleQueryValue(query.domain) ?? "all";
  const domain = rawDomain === "all" || CONTROL_TOWER_DOMAINS.includes(rawDomain as ControlTowerDomain)
    ? rawDomain as ControlTowerDomain | "all"
    : null;
  if (!domain) throw new ControlTowerRequestError("Unsupported domain", 400, "INVALID_DOMAIN");

  const rawSeverity = singleQueryValue(query.severity) ?? "all";
  const severity = rawSeverity === "all" || CONTROL_TOWER_SEVERITIES.includes(rawSeverity as ControlTowerSeverity)
    ? rawSeverity as ControlTowerSeverity | "all"
    : null;
  if (!severity) throw new ControlTowerRequestError("Unsupported severity", 400, "INVALID_SEVERITY");

  return {
    view,
    domain,
    severity,
    ownerTeam: boundedOptionalQuery(query.ownerTeam, "ownerTeam", 50),
    assignedUserId: boundedOptionalQuery(query.assignedUserId, "assignedUserId", 120),
    search: boundedOptionalQuery(query.search, "search", 200) ?? "",
    limit: parseLimit(query.limit),
    cursor: boundedOptionalQuery(query.cursor, "cursor", 1_000),
  };
}

function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): QueueCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<QueueCursor>;
    const date = new Date(String(parsed.sortAt ?? ""));
    if (
      !Number.isInteger(parsed.severityRank)
      || Number(parsed.severityRank) < 0
      || Number(parsed.severityRank) > 3
      || !Number.isSafeInteger(parsed.id)
      || Number(parsed.id) <= 0
      || Number.isNaN(date.getTime())
    ) {
      throw new Error("invalid cursor data");
    }
    return {
      severityRank: Number(parsed.severityRank),
      sortAt: date.toISOString(),
      id: Number(parsed.id),
    };
  } catch {
    throw new ControlTowerRequestError("Invalid pagination cursor", 400, "INVALID_CURSOR");
  }
}

function viewPredicate(view: ControlTowerView, alias = "work_item"): string {
  if (view === "attention") {
    return `(
      ${alias}.triage_status = 'needs_attention'
      OR (${alias}.triage_status = 'waiting' AND ${alias}.next_review_at <= NOW())
    ) AND ${alias}.source_status NOT IN ('resolved', 'ignored')`;
  }
  if (view === "in_progress") {
    return `${alias}.triage_status = 'in_progress' AND ${alias}.source_status NOT IN ('resolved', 'ignored')`;
  }
  if (view === "waiting") {
    return `${alias}.triage_status = 'waiting'
      AND (${alias}.next_review_at IS NULL OR ${alias}.next_review_at > NOW())
      AND ${alias}.source_status NOT IN ('resolved', 'ignored')`;
  }
  return `${alias}.triage_status = 'resolved'`;
}

const SEVERITY_RANK_SQL = `CASE work_item.severity
  WHEN 'blocker' THEN 0
  WHEN 'high' THEN 1
  WHEN 'medium' THEN 2
  ELSE 3
END`;

function addFilter(
  conditions: string[],
  values: unknown[],
  sql: (parameter: string) => string,
  value: unknown,
): void {
  values.push(value);
  conditions.push(sql(`$${values.length}`));
}

function commonFilterSql(params: {
  filters: ControlTowerQueueFilters;
  includeView: boolean;
  includeDomain: boolean;
  values: unknown[];
}): string[] {
  const conditions: string[] = ["NOT ('system_control' = ANY(work_item.impact_tags))"];
  if (params.includeView) conditions.push(viewPredicate(params.filters.view));
  if (params.includeDomain && params.filters.domain !== "all") {
    addFilter(conditions, params.values, (parameter) => `work_item.domain = ${parameter}`, params.filters.domain);
  }
  if (params.filters.severity !== "all") {
    addFilter(conditions, params.values, (parameter) => `work_item.severity = ${parameter}`, params.filters.severity);
  }
  if (params.filters.ownerTeam) {
    addFilter(conditions, params.values, (parameter) => `work_item.owner_team = ${parameter}`, params.filters.ownerTeam);
  }
  if (params.filters.assignedUserId) {
    addFilter(conditions, params.values, (parameter) => `work_item.assigned_user_id = ${parameter}`, params.filters.assignedUserId);
  }
  if (params.filters.search) {
    addFilter(
      conditions,
      params.values,
      (parameter) => `work_item.search_document @@ plainto_tsquery('simple', ${parameter})`,
      params.filters.search,
    );
  }
  return conditions;
}

function encodeGroupCursor(cursor: GroupCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeGroupCursor(value: string | null): GroupCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<GroupCursor>;
    const date = new Date(String(parsed.sortAt ?? ""));
    const groupKey = String(parsed.groupKey ?? "").trim();
    if (
      !Number.isInteger(parsed.severityRank)
      || Number(parsed.severityRank) < 0
      || Number(parsed.severityRank) > 3
      || Number.isNaN(date.getTime())
      || !groupKey
      || groupKey.length > 200
    ) {
      throw new Error("invalid group cursor data");
    }
    return {
      severityRank: Number(parsed.severityRank),
      sortAt: date.toISOString(),
      groupKey,
    };
  } catch {
    throw new ControlTowerRequestError("Invalid pagination cursor", 400, "INVALID_CURSOR");
  }
}

export function parseControlTowerV2GroupKey(value: unknown): string {
  const groupKey = String(value ?? "").trim();
  if (!groupKey || groupKey.length > 200) {
    throw new ControlTowerRequestError("A valid root-cause group key is required", 400, "INVALID_GROUP_KEY");
  }
  return groupKey;
}

const ROOT_CAUSE_GROUP_SQL = `COALESCE(
  NULLIF(work_item.root_cause_group_key, ''),
  CONCAT(work_item.domain, ':', work_item.code)
)`;

function integer(value: unknown): number {
  return Number(value ?? 0);
}

function queueItem(row: Record<string, unknown>) {
  return {
    id: integer(row.id),
    domain: row.domain,
    code: row.code,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityRef: row.entity_ref,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    urgency: row.urgency,
    impactTags: row.impact_tags ?? [],
    actionability: row.actionability,
    sourceStatus: row.source_status,
    triageStatus: row.effective_triage_status,
    ownerTeam: row.owner_team,
    assignedUserId: row.assigned_user_id,
    assignedUserName: row.assigned_user_name,
    recommendedAction: row.recommended_action,
    responseDueAt: row.response_due_at,
    nextReviewAt: row.next_review_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastChangedAt: row.last_changed_at,
    resolvedAt: row.resolved_at,
    occurrenceCount: integer(row.occurrence_count),
    recurrenceCount: integer(row.recurrence_count),
    worsenedCount: integer(row.worsened_count),
    ageMinutes: integer(row.age_minutes),
    rowVersion: integer(row.row_version),
    sourceName: row.source_namespace,
  };
}

export async function getControlTowerV2Queue(params: {
  client: QueryClient;
  filters: ControlTowerQueueFilters;
  rootCauseGroupKey?: string;
}) {
  const cursor = decodeCursor(params.filters.cursor);
  const values: unknown[] = [];
  const conditions = commonFilterSql({
    filters: params.filters,
    includeView: true,
    includeDomain: true,
    values,
  });
  if (params.rootCauseGroupKey) {
    addFilter(
      conditions,
      values,
      (parameter) => `${ROOT_CAUSE_GROUP_SQL} = ${parameter}`,
      params.rootCauseGroupKey,
    );
  }
  const sortColumn = params.filters.view === "resolved"
    ? "COALESCE(work_item.resolved_at, work_item.updated_at)"
    : "work_item.first_seen_at";
  const sortDirection = params.filters.view === "resolved" ? "DESC" : "ASC";
  if (cursor) {
    values.push(cursor.severityRank, cursor.sortAt, cursor.id);
    const rankParameter = `$${values.length - 2}`;
    const dateParameter = `$${values.length - 1}`;
    const idParameter = `$${values.length}`;
    const dateComparator = params.filters.view === "resolved" ? "<" : ">";
    conditions.push(`(
      ${SEVERITY_RANK_SQL} > ${rankParameter}
      OR (
        ${SEVERITY_RANK_SQL} = ${rankParameter}
        AND ${sortColumn} ${dateComparator} ${dateParameter}::TIMESTAMPTZ
      )
      OR (
        ${SEVERITY_RANK_SQL} = ${rankParameter}
        AND ${sortColumn} = ${dateParameter}::TIMESTAMPTZ
        AND work_item.id > ${idParameter}
      )
    )`);
  }
  values.push(params.filters.limit + 1);
  const pageLimitParameter = `$${values.length}`;

  const result = await params.client.query(`
    SELECT
      work_item.id,
      work_item.domain,
      work_item.code,
      work_item.entity_type,
      work_item.entity_id,
      work_item.entity_ref,
      work_item.title,
      work_item.summary,
      work_item.severity,
      work_item.urgency,
      work_item.impact_tags,
      work_item.actionability,
      work_item.source_status,
      CASE
        WHEN work_item.triage_status = 'waiting' AND work_item.next_review_at <= NOW()
          THEN 'needs_attention'
        ELSE work_item.triage_status
      END AS effective_triage_status,
      work_item.owner_team,
      work_item.assigned_user_id,
      COALESCE(assigned_user.display_name, assigned_user.username) AS assigned_user_name,
      work_item.recommended_action,
      work_item.response_due_at,
      work_item.next_review_at,
      work_item.first_seen_at,
      work_item.last_seen_at,
      work_item.last_changed_at,
      work_item.resolved_at,
      work_item.occurrence_count,
      work_item.recurrence_count,
      work_item.worsened_count,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - work_item.first_seen_at)) / 60)::INTEGER AS age_minutes,
      work_item.row_version,
      work_item.source_namespace,
      ${SEVERITY_RANK_SQL} AS severity_rank,
      ${sortColumn} AS sort_at
    FROM operations.control_tower_work_items AS work_item
    LEFT JOIN identity.users AS assigned_user
      ON assigned_user.id = work_item.assigned_user_id
    WHERE ${conditions.length > 0 ? conditions.join(" AND ") : "TRUE"}
    ORDER BY ${SEVERITY_RANK_SQL} ASC, ${sortColumn} ${sortDirection}, work_item.id ASC
    LIMIT ${pageLimitParameter}
  `, values);

  const hasNextPage = result.rows.length > params.filters.limit;
  const pageRows = hasNextPage ? result.rows.slice(0, params.filters.limit) : result.rows;
  const last = pageRows.at(-1) as Record<string, unknown> | undefined;
  return {
    items: pageRows.map((row) => queueItem(row as Record<string, unknown>)),
    nextCursor: hasNextPage && last
      ? encodeCursor({
          severityRank: integer(last.severity_rank),
          sortAt: new Date(String(last.sort_at)).toISOString(),
          id: integer(last.id),
        })
      : null,
  };
}

async function getControlTowerV2Counts(params: {
  client: QueryClient;
  filters: ControlTowerQueueFilters;
}) {
  const viewValues: unknown[] = [];
  const viewFilters = commonFilterSql({
    filters: params.filters,
    includeView: false,
    includeDomain: true,
    values: viewValues,
  });
  const viewResult = await params.client.query(`
    SELECT
      COUNT(*) FILTER (WHERE ${viewPredicate("attention")})::TEXT AS attention,
      COUNT(*) FILTER (WHERE ${viewPredicate("in_progress")})::TEXT AS in_progress,
      COUNT(*) FILTER (WHERE ${viewPredicate("waiting")})::TEXT AS waiting,
      COUNT(*) FILTER (WHERE ${viewPredicate("resolved")})::TEXT AS resolved
    FROM operations.control_tower_work_items AS work_item
    WHERE ${viewFilters.length > 0 ? viewFilters.join(" AND ") : "TRUE"}
  `, viewValues);

  const domainValues: unknown[] = [];
  const domainFilters = commonFilterSql({
    filters: params.filters,
    includeView: true,
    includeDomain: false,
    values: domainValues,
  });
  const domainResult = await params.client.query(`
    SELECT work_item.domain, COUNT(*)::TEXT AS count
    FROM operations.control_tower_work_items AS work_item
    WHERE ${domainFilters.length > 0 ? domainFilters.join(" AND ") : "TRUE"}
    GROUP BY work_item.domain
  `, domainValues);

  const totalValues: unknown[] = [];
  const totalFilters = commonFilterSql({
    filters: params.filters,
    includeView: true,
    includeDomain: true,
    values: totalValues,
  });
  const totalResult = await params.client.query(`
    SELECT COUNT(*)::TEXT AS count
    FROM operations.control_tower_work_items AS work_item
    WHERE ${totalFilters.length > 0 ? totalFilters.join(" AND ") : "TRUE"}
  `, totalValues);

  const viewRow = viewResult.rows[0] as Record<string, unknown> | undefined;
  return {
    total: integer((totalResult.rows[0] as Record<string, unknown> | undefined)?.count),
    viewCounts: {
      attention: integer(viewRow?.attention),
      inProgress: integer(viewRow?.in_progress),
      waiting: integer(viewRow?.waiting),
      resolved: integer(viewRow?.resolved),
    },
    domainCounts: Object.fromEntries(
      CONTROL_TOWER_DOMAINS.map((domain) => [
        domain,
        integer((domainResult.rows as Record<string, unknown>[]).find((row) => row.domain === domain)?.count),
      ]),
    ),
  };
}

export async function loadControlTowerV2Queue(params: {
  client: QueryClient;
  filters: ControlTowerQueueFilters;
}) {
  const [page, counts] = await Promise.all([
    getControlTowerV2Queue(params),
    getControlTowerV2Counts(params),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    filters: params.filters,
    ...counts,
    ...page,
  };
}

function groupItem(row: Record<string, unknown>) {
  return {
    groupKey: row.group_key,
    domain: row.domain,
    code: row.code,
    title: row.title,
    summary: row.summary,
    expectedState: row.expected_state,
    actualState: row.actual_state,
    recommendedAction: row.recommended_action,
    severity: row.severity,
    urgency: row.urgency,
    triageStatus: row.effective_triage_status,
    ownerTeam: row.owner_team,
    affectedRecords: integer(row.affected_records),
    affectedEntities: integer(row.affected_entities),
    recurrenceCount: integer(row.recurrence_count),
    worsenedCount: integer(row.worsened_count),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastChangedAt: row.last_changed_at,
    responseDueAt: row.response_due_at,
    ageMinutes: integer(row.age_minutes),
    representativeId: integer(row.representative_id),
    sampleEntityRefs: row.sample_entity_refs ?? [],
    sourceNames: row.source_names ?? [],
  };
}

async function getControlTowerV2GroupPage(params: {
  client: QueryClient;
  filters: ControlTowerQueueFilters;
  rootCauseGroupKey?: string;
}) {
  const cursor = decodeGroupCursor(params.filters.cursor);
  const values: unknown[] = [];
  const conditions = commonFilterSql({
    filters: params.filters,
    includeView: true,
    includeDomain: true,
    values,
  });
  if (params.rootCauseGroupKey) {
    addFilter(
      conditions,
      values,
      (parameter) => `${ROOT_CAUSE_GROUP_SQL} = ${parameter}`,
      params.rootCauseGroupKey,
    );
  }

  const resolvedView = params.filters.view === "resolved";
  const sourceSortColumn = resolvedView
    ? "COALESCE(work_item.resolved_at, work_item.updated_at)"
    : "work_item.first_seen_at";
  const groupedSortFunction = resolvedView ? "MAX" : "MIN";
  const sortDirection = resolvedView ? "DESC" : "ASC";
  const groupedConditions: string[] = [];
  if (cursor) {
    values.push(cursor.severityRank, cursor.sortAt, cursor.groupKey);
    const rankParameter = `$${values.length - 2}`;
    const dateParameter = `$${values.length - 1}`;
    const keyParameter = `$${values.length}`;
    const dateComparator = resolvedView ? "<" : ">";
    groupedConditions.push(`(
      grouped.severity_rank > ${rankParameter}
      OR (
        grouped.severity_rank = ${rankParameter}
        AND grouped.sort_at ${dateComparator} ${dateParameter}::TIMESTAMPTZ
      )
      OR (
        grouped.severity_rank = ${rankParameter}
        AND grouped.sort_at = ${dateParameter}::TIMESTAMPTZ
        AND grouped.group_key > ${keyParameter}
      )
    )`);
  }
  values.push(params.filters.limit + 1);
  const limitParameter = `$${values.length}`;

  const result = await params.client.query(`
    WITH filtered AS (
      SELECT
        work_item.*,
        ${ROOT_CAUSE_GROUP_SQL} AS group_key,
        ${SEVERITY_RANK_SQL} AS severity_rank,
        ${sourceSortColumn} AS source_sort_at,
        CASE
          WHEN work_item.triage_status = 'waiting' AND work_item.next_review_at <= NOW()
            THEN 'needs_attention'
          ELSE work_item.triage_status
        END AS effective_triage_status
      FROM operations.control_tower_work_items AS work_item
      WHERE ${conditions.length > 0 ? conditions.join(" AND ") : "TRUE"}
    ), grouped AS (
      SELECT
        group_key,
        (ARRAY_AGG(domain ORDER BY severity_rank, first_seen_at, id))[1] AS domain,
        (ARRAY_AGG(code ORDER BY severity_rank, first_seen_at, id))[1] AS code,
        (ARRAY_AGG(title ORDER BY severity_rank, first_seen_at, id))[1] AS title,
        (ARRAY_AGG(summary ORDER BY severity_rank, first_seen_at, id))[1] AS summary,
        (ARRAY_AGG(expected_state ORDER BY severity_rank, first_seen_at, id))[1] AS expected_state,
        (ARRAY_AGG(actual_state ORDER BY severity_rank, first_seen_at, id))[1] AS actual_state,
        (ARRAY_AGG(recommended_action ORDER BY severity_rank, first_seen_at, id))[1] AS recommended_action,
        CASE MIN(severity_rank)
          WHEN 0 THEN 'blocker'
          WHEN 1 THEN 'high'
          WHEN 2 THEN 'medium'
          ELSE 'low'
        END AS severity,
        MIN(severity_rank) AS severity_rank,
        CASE MIN(CASE urgency
          WHEN 'overdue' THEN 0
          WHEN 'due_soon' THEN 1
          WHEN 'normal' THEN 2
          ELSE 3
        END)
          WHEN 0 THEN 'overdue'
          WHEN 1 THEN 'due_soon'
          WHEN 2 THEN 'normal'
          ELSE 'deferred'
        END AS urgency,
        (ARRAY_AGG(effective_triage_status ORDER BY severity_rank, first_seen_at, id))[1] AS effective_triage_status,
        CASE
          WHEN COUNT(DISTINCT owner_team) FILTER (WHERE owner_team IS NOT NULL) = 1
            THEN MAX(owner_team)
          ELSE NULL
        END AS owner_team,
        COUNT(*)::TEXT AS affected_records,
        COUNT(DISTINCT CONCAT(entity_type, CHR(31), entity_id))::TEXT AS affected_entities,
        COALESCE(SUM(recurrence_count), 0)::TEXT AS recurrence_count,
        COALESCE(SUM(worsened_count), 0)::TEXT AS worsened_count,
        MIN(first_seen_at) AS first_seen_at,
        MAX(last_seen_at) AS last_seen_at,
        MAX(last_changed_at) AS last_changed_at,
        MIN(response_due_at) AS response_due_at,
        ${groupedSortFunction}(source_sort_at) AS sort_at,
        (ARRAY_AGG(id ORDER BY severity_rank, first_seen_at, id))[1] AS representative_id,
        (ARRAY_REMOVE(ARRAY_AGG(DISTINCT entity_ref), NULL))[1:5] AS sample_entity_refs,
        ARRAY_AGG(DISTINCT source_namespace) AS source_names
      FROM filtered
      GROUP BY group_key
    )
    SELECT
      grouped.*,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - grouped.first_seen_at)) / 60)::INTEGER AS age_minutes
    FROM grouped
    WHERE ${groupedConditions.length > 0 ? groupedConditions.join(" AND ") : "TRUE"}
    ORDER BY grouped.severity_rank ASC, grouped.sort_at ${sortDirection}, grouped.group_key ASC
    LIMIT ${limitParameter}
  `, values);

  const hasNextPage = result.rows.length > params.filters.limit;
  const pageRows = hasNextPage ? result.rows.slice(0, params.filters.limit) : result.rows;
  const last = pageRows.at(-1) as Record<string, unknown> | undefined;
  return {
    groups: pageRows.map((row) => groupItem(row as Record<string, unknown>)),
    nextCursor: hasNextPage && last
      ? encodeGroupCursor({
          severityRank: integer(last.severity_rank),
          sortAt: new Date(String(last.sort_at)).toISOString(),
          groupKey: String(last.group_key),
        })
      : null,
  };
}

async function getControlTowerV2GroupCounts(params: {
  client: QueryClient;
  filters: ControlTowerQueueFilters;
}) {
  const viewValues: unknown[] = [];
  const viewFilters = commonFilterSql({
    filters: params.filters,
    includeView: false,
    includeDomain: true,
    values: viewValues,
  });
  const viewResult = await params.client.query(`
    SELECT
      COUNT(DISTINCT ${ROOT_CAUSE_GROUP_SQL}) FILTER (WHERE ${viewPredicate("attention")})::TEXT AS attention,
      COUNT(*) FILTER (WHERE ${viewPredicate("attention")})::TEXT AS attention_records,
      COUNT(DISTINCT ${ROOT_CAUSE_GROUP_SQL}) FILTER (WHERE ${viewPredicate("in_progress")})::TEXT AS in_progress,
      COUNT(*) FILTER (WHERE ${viewPredicate("in_progress")})::TEXT AS in_progress_records,
      COUNT(DISTINCT ${ROOT_CAUSE_GROUP_SQL}) FILTER (WHERE ${viewPredicate("waiting")})::TEXT AS waiting,
      COUNT(*) FILTER (WHERE ${viewPredicate("waiting")})::TEXT AS waiting_records,
      COUNT(DISTINCT ${ROOT_CAUSE_GROUP_SQL}) FILTER (WHERE ${viewPredicate("resolved")})::TEXT AS resolved,
      COUNT(*) FILTER (WHERE ${viewPredicate("resolved")})::TEXT AS resolved_records
    FROM operations.control_tower_work_items AS work_item
    WHERE ${viewFilters.length > 0 ? viewFilters.join(" AND ") : "TRUE"}
  `, viewValues);

  const domainValues: unknown[] = [];
  const domainFilters = commonFilterSql({
    filters: params.filters,
    includeView: true,
    includeDomain: false,
    values: domainValues,
  });
  const domainResult = await params.client.query(`
    SELECT
      work_item.domain,
      COUNT(DISTINCT ${ROOT_CAUSE_GROUP_SQL})::TEXT AS group_count,
      COUNT(*)::TEXT AS affected_records
    FROM operations.control_tower_work_items AS work_item
    WHERE ${domainFilters.length > 0 ? domainFilters.join(" AND ") : "TRUE"}
    GROUP BY work_item.domain
  `, domainValues);

  const totalValues: unknown[] = [];
  const totalFilters = commonFilterSql({
    filters: params.filters,
    includeView: true,
    includeDomain: true,
    values: totalValues,
  });
  const totalResult = await params.client.query(`
    SELECT
      COUNT(DISTINCT ${ROOT_CAUSE_GROUP_SQL})::TEXT AS group_count,
      COUNT(*)::TEXT AS affected_records
    FROM operations.control_tower_work_items AS work_item
    WHERE ${totalFilters.length > 0 ? totalFilters.join(" AND ") : "TRUE"}
  `, totalValues);

  const viewRow = viewResult.rows[0] as Record<string, unknown> | undefined;
  const totalRow = totalResult.rows[0] as Record<string, unknown> | undefined;
  const domainRows = domainResult.rows as Record<string, unknown>[];
  return {
    totalGroups: integer(totalRow?.group_count),
    totalAffectedRecords: integer(totalRow?.affected_records),
    viewCounts: {
      attention: integer(viewRow?.attention),
      inProgress: integer(viewRow?.in_progress),
      waiting: integer(viewRow?.waiting),
      resolved: integer(viewRow?.resolved),
    },
    viewAffectedRecords: {
      attention: integer(viewRow?.attention_records),
      inProgress: integer(viewRow?.in_progress_records),
      waiting: integer(viewRow?.waiting_records),
      resolved: integer(viewRow?.resolved_records),
    },
    domainCounts: Object.fromEntries(
      CONTROL_TOWER_DOMAINS.map((domain) => [
        domain,
        integer(domainRows.find((row) => row.domain === domain)?.group_count),
      ]),
    ),
    domainAffectedRecords: Object.fromEntries(
      CONTROL_TOWER_DOMAINS.map((domain) => [
        domain,
        integer(domainRows.find((row) => row.domain === domain)?.affected_records),
      ]),
    ),
  };
}

export async function loadControlTowerV2Groups(params: {
  client: QueryClient;
  filters: ControlTowerQueueFilters;
}) {
  const [page, counts] = await Promise.all([
    getControlTowerV2GroupPage(params),
    getControlTowerV2GroupCounts(params),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    filters: params.filters,
    ...counts,
    ...page,
  };
}

export async function getControlTowerV2GroupDetail(params: {
  client: QueryClient;
  filters: ControlTowerQueueFilters;
  groupKey: string;
}) {
  const aggregateFilters = { ...params.filters, cursor: null, limit: 1 };
  const [groupPage, instancePage] = await Promise.all([
    getControlTowerV2GroupPage({
      client: params.client,
      filters: aggregateFilters,
      rootCauseGroupKey: params.groupKey,
    }),
    getControlTowerV2Queue({
      client: params.client,
      filters: params.filters,
      rootCauseGroupKey: params.groupKey,
    }),
  ]);
  const group = groupPage.groups[0] ?? null;
  if (!group) return null;
  return {
    generatedAt: new Date().toISOString(),
    group,
    instances: instancePage.items,
    nextCursor: instancePage.nextCursor,
  };
}

export async function getControlTowerV2Detail(params: {
  client: QueryClient;
  id: number;
  includeTechnicalEvidence: boolean;
  now?: Date;
}) {
  const workItemResult = await params.client.query(`
    SELECT
      work_item.*,
      COALESCE(assigned_user.display_name, assigned_user.username) AS assigned_user_name
    FROM operations.control_tower_work_items AS work_item
    LEFT JOIN identity.users AS assigned_user
      ON assigned_user.id = work_item.assigned_user_id
    WHERE work_item.id = $1
  `, [params.id]);
  const row = workItemResult.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const [observationsResult, attemptsResult, relatedResult, sourceRunResult] = await Promise.all([
    params.client.query(`
      SELECT
        observation.id,
        observation.observation_kind,
        observation.prior_source_status,
        observation.current_source_status,
        observation.prior_triage_status,
        observation.current_triage_status,
        observation.changed_fields,
        observation.evidence_summary,
        observation.observed_metric,
        observation.actor_user_id,
        COALESCE(actor.display_name, actor.username) AS actor_name,
        observation.note,
        observation.source_observed_at,
        observation.created_at
      FROM operations.control_tower_observations AS observation
      LEFT JOIN identity.users AS actor
        ON actor.id = observation.actor_user_id
      WHERE observation.work_item_id = $1
      ORDER BY observation.created_at DESC, observation.id DESC
      LIMIT 100
    `, [params.id]),
    params.client.query(`
      SELECT
        id,
        action_code,
        requested_by,
        requested_at,
        status,
        attempt_count,
        started_at,
        completed_at,
        result_summary,
        error_code,
        error_message
      FROM operations.control_tower_action_attempts
      WHERE work_item_id = $1
      ORDER BY requested_at DESC, id DESC
      LIMIT 50
    `, [params.id]),
    params.client.query(`
      SELECT id, domain, code, entity_ref, title, severity, triage_status
      FROM operations.control_tower_work_items
      WHERE id <> $1
        AND (
          ($2::VARCHAR IS NOT NULL AND correlation_id = $2)
          OR ($3::VARCHAR IS NOT NULL AND root_cause_group_key = $3)
        )
      ORDER BY CASE severity
        WHEN 'blocker' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        ELSE 3
      END, first_seen_at ASC
      LIMIT 20
    `, [params.id, row.correlation_id ?? null, row.root_cause_group_key ?? null]),
    row.last_source_run_id
      ? params.client.query(`
          SELECT
            id,
            source_name,
            projector_version,
            status,
            complete_scan,
            started_at,
            completed_at,
            duration_ms,
            rows_scanned,
            rows_created,
            rows_updated,
            rows_resolved,
            rows_failed,
            source_watermark,
            error_code,
            error_message
          FROM operations.control_tower_source_runs
          WHERE id = $1
        `, [row.last_source_run_id])
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    item: {
      ...queueItem({
        ...row,
        effective_triage_status: row.triage_status === "waiting"
          && row.next_review_at
          && new Date(String(row.next_review_at)).getTime() <= (params.now ?? new Date()).getTime()
          ? "needs_attention"
          : row.triage_status,
        age_minutes: Math.max(0, Math.floor(((params.now ?? new Date()).getTime() - new Date(String(row.first_seen_at)).getTime()) / 60_000)),
      }),
      expectedState: row.expected_state,
      actualState: row.actual_state,
      correlationId: row.correlation_id,
      rootCauseGroupKey: row.root_cause_group_key,
      detailLocator: row.detail_locator,
      availableActions: row.available_actions,
      sourceUpdatedAt: row.source_updated_at,
      technicalEvidence: params.includeTechnicalEvidence ? row.evidence_summary : undefined,
    },
    observations: observationsResult.rows,
    actionAttempts: attemptsResult.rows,
    relatedItems: relatedResult.rows,
    sourceRun: sourceRunResult.rows[0] ?? null,
  };
}

function sourceStaleMinutes(): number {
  const configured = Number(process.env.CONTROL_TOWER_SOURCE_STALE_MINUTES);
  return Number.isInteger(configured) && configured >= 5 && configured <= 1_440
    ? configured
    : DEFAULT_SOURCE_STALE_MINUTES;
}

export async function getControlTowerV2Sources(client: QueryClient) {
  // Keep source-health reads sequential so a diagnostic refresh does not fan
  // out avoidable database work alongside transactional application traffic.
  const runsResult = await client.query(`
      SELECT DISTINCT ON (source_name)
        id,
        source_name,
        projector_version,
        status,
        complete_scan,
        started_at,
        completed_at,
        duration_ms,
        rows_scanned,
        rows_created,
        rows_updated,
        rows_resolved,
        rows_failed,
        source_watermark,
        error_code,
        error_message
      FROM operations.control_tower_source_runs
      ORDER BY source_name, started_at DESC
    `);
  const countsResult = await client.query(`
      SELECT
        source_namespace,
        COUNT(*) FILTER (WHERE NOT ('system_control' = ANY(impact_tags)))::TEXT AS operator_open_count,
        COUNT(*) FILTER (WHERE 'system_control' = ANY(impact_tags))::TEXT AS control_gap_count
      FROM operations.control_tower_work_items
      WHERE triage_status <> 'resolved'
        AND source_status NOT IN ('resolved', 'ignored')
      GROUP BY source_namespace
    `);
  const controlsResult = await client.query(`
      SELECT
        ${ROOT_CAUSE_GROUP_SQL} AS group_key,
        work_item.domain,
        work_item.code,
        MIN(work_item.title) AS title,
        MIN(work_item.summary) AS summary,
        CASE MIN(${SEVERITY_RANK_SQL})
          WHEN 0 THEN 'blocker'
          WHEN 1 THEN 'high'
          WHEN 2 THEN 'medium'
          ELSE 'low'
        END AS severity,
        COUNT(*)::TEXT AS affected_records,
        MIN(work_item.first_seen_at) AS first_seen_at,
        MAX(work_item.last_seen_at) AS last_seen_at,
        MAX(work_item.last_changed_at) AS last_changed_at
      FROM operations.control_tower_work_items AS work_item
      WHERE 'system_control' = ANY(work_item.impact_tags)
        AND work_item.triage_status <> 'resolved'
        AND work_item.source_status NOT IN ('resolved', 'ignored')
      GROUP BY ${ROOT_CAUSE_GROUP_SQL}, work_item.domain, work_item.code
      ORDER BY MIN(${SEVERITY_RANK_SQL}), MIN(work_item.first_seen_at), ${ROOT_CAUSE_GROUP_SQL}
    `);
  const staleMinutes = sourceStaleMinutes();
  const now = Date.now();
  const latestRuns = new Map(
    (runsResult.rows as Record<string, unknown>[]).map((row) => [String(row.source_name), row]),
  );
  const openCounts = new Map(
    (countsResult.rows as Record<string, unknown>[]).map((row) => [String(row.source_namespace), {
      operatorOpen: integer(row.operator_open_count),
      controlGaps: integer(row.control_gap_count),
    }]),
  );

  return {
    generatedAt: new Date(now).toISOString(),
    staleAfterMinutes: staleMinutes,
    controlGaps: (controlsResult.rows as Record<string, unknown>[]).map((row) => ({
      groupKey: row.group_key,
      domain: row.domain,
      code: row.code,
      title: row.title,
      summary: row.summary,
      severity: row.severity,
      affectedRecords: integer(row.affected_records),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastChangedAt: row.last_changed_at,
    })),
    sources: CONTROL_TOWER_SOURCE_ADAPTERS.map((adapter) => {
      const run = latestRuns.get(adapter.name);
      const sourceCounts = openCounts.get(adapter.sourceNamespace) ?? { operatorOpen: 0, controlGaps: 0 };
      if (!run) {
        return {
          name: adapter.name,
          sourceNamespace: adapter.sourceNamespace,
          status: "never_run",
          projectionVersion: adapter.projectionVersion,
          openItemCount: sourceCounts.operatorOpen,
          controlGapCount: sourceCounts.controlGaps,
          lastRun: null,
        };
      }
      const startedAt = run.started_at ? new Date(String(run.started_at)) : null;
      const completedAt = run.completed_at ? new Date(String(run.completed_at)) : null;
      const ageReference = completedAt ?? startedAt;
      const ageMinutes = ageReference ? Math.max(0, Math.floor((now - ageReference.getTime()) / 60_000)) : null;
      const status = run.status === "failed"
        ? "failed"
        : run.status === "partial"
          ? "degraded"
          : run.status === "running"
            ? ageMinutes !== null && ageMinutes > staleMinutes ? "stale" : "refreshing"
            : run.status === "skipped"
              ? "degraded"
              : run.projector_version !== adapter.projectionVersion
                ? "version_mismatch"
                : ageMinutes !== null && ageMinutes > staleMinutes
                  ? "stale"
                  : "healthy";
      return {
        name: adapter.name,
        sourceNamespace: adapter.sourceNamespace,
        status,
        projectionVersion: adapter.projectionVersion,
        openItemCount: sourceCounts.operatorOpen,
        controlGapCount: sourceCounts.controlGaps,
        ageMinutes,
        lastRun: run,
      };
    }),
  };
}

export async function getControlTowerV2Assignees(client: QueryClient) {
  const result = await client.query(`
    SELECT id, username, display_name
    FROM identity.users
    WHERE active = 1
    ORDER BY COALESCE(display_name, username), id
  `);
  return result.rows.map((row) => ({
    id: String((row as Record<string, unknown>).id),
    username: String((row as Record<string, unknown>).username),
    displayName: (row as Record<string, unknown>).display_name == null
      ? null
      : String((row as Record<string, unknown>).display_name),
  }));
}
