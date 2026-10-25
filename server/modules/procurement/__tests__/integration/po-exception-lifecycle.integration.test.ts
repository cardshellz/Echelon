import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PoFinancialRefreshFixture } from './po-financial-refresh.fixture';

// These real-owner cases replace the seven deferred database-mock cases in
// po-exceptions.service.test.ts. The fixture rejects nonlocal or nondisposable
// databases and redirects only the transport, not the business owner.
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = databaseUrl && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === 'true'
  ? describe : describe.skip;

databaseTests.sequential('PO exception lifecycle with real PostgreSQL evidence', () => {
  const fixture = new PoFinancialRefreshFixture();
  let owner: typeof import('../../po-exceptions.service');
  const actor = 'exception-lifecycle-reviewer';
  const input = {
    poId: 10, kind: 'qty_short' as const, severity: 'warn' as const,
    title: 'Short by two pieces', message: 'Supplier short shipment',
    payload: { lineId: 21, shortedQty: 2 }, detectedBy: 'exception-lifecycle:detector',
  };

  beforeAll(async () => {
    await fixture.start(databaseUrl!);
    await fixture.pool.query(readFileSync('migrations/0566_po_exceptions.sql', 'utf8'));
    owner = await import('../../po-exceptions.service');
  });
  beforeEach(() => fixture.seed());
  afterAll(() => fixture.stop());

  async function saved(id: number) {
    return (await fixture.pool.query('SELECT * FROM procurement.po_exceptions WHERE id=$1', [id])).rows[0];
  }
  async function history() {
    return (await fixture.pool.query('SELECT * FROM procurement.po_status_history WHERE purchase_order_id=10 ORDER BY id')).rows;
  }
  function assertAudit(row: Record<string, unknown>, who: string | null, notes: string) {
    expect(row).toMatchObject({ purchase_order_id: 10, from_status: 'sent', to_status: 'sent', changed_by: who, notes });
    expect(row.changed_at).toBeInstanceOf(Date);
  }

  it('inserts a new actionable row and the detection history in PostgreSQL', async () => {
    const created = await owner.upsertException(input);
    expect(created).toMatchObject({ poId: 10, kind: 'qty_short', severity: 'warn', status: 'open', title: input.title });
    expect(created.id).toBeGreaterThan(0);
    expect(created.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await saved(created.id)).toMatchObject({ po_id: 10, kind: 'qty_short', status: 'open', payload: input.payload, payload_hash: created.payloadHash, detected_by: input.detectedBy });
    expect(created.detectedAt).toBeInstanceOf(Date);
    const audit = await history();
    expect(audit).toHaveLength(1);
    // The detector contract stores detectedBy on the exception; its history
    // currently has no actor argument. Do not invent an actor audit guarantee.
    assertAudit(audit[0], null, 'Exception detected: qty_short — Short by two pieces');
  });

  it('updates the same-hash open row without creating another exception or detection history', async () => {
    const first = await owner.upsertException(input);
    const originalAudit = await history();
    const updated = await owner.upsertException({ ...input, severity: 'error', title: 'Short shipment needs follow-up', message: 'Rechecked with supplier' });
    expect(updated).toMatchObject({ id: first.id, payloadHash: first.payloadHash, status: 'open', severity: 'error', title: 'Short shipment needs follow-up', message: 'Rechecked with supplier' });
    expect(updated.detectedAt.getTime()).toBeGreaterThanOrEqual(first.detectedAt.getTime());
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM procurement.po_exceptions')).rows[0].count).toBe(1);
    expect(await saved(first.id)).toMatchObject({ severity: 'error', title: 'Short shipment needs follow-up', message: 'Rechecked with supplier', payload_hash: first.payloadHash });
    expect(await history()).toEqual(originalAudit);
  });

  it('acknowledges a known open row with the actual actor, timestamp and history', async () => {
    const created = await owner.upsertException(input);
    const result = await owner.acknowledgeException(created.id, actor);
    expect(result).toMatchObject({ status: 'acknowledged', acknowledgedBy: actor });
    expect(result.acknowledgedAt).toBeInstanceOf(Date);
    expect(await saved(created.id)).toMatchObject({ status: 'acknowledged', acknowledged_by: actor, acknowledged_at: result.acknowledgedAt });
    const audit = await history();
    expect(audit).toHaveLength(2);
    assertAudit(audit[1], actor, `Exception acknowledged: qty_short — Short by two pieces (by ${actor})`);
  });

  it('rejects acknowledgment of a known resolved row without changing any fixture records', async () => {
    const created = await owner.upsertException(input);
    await owner.resolveException(created.id, actor, 'Supplier short accepted');
    const before = await fixture.snapshot();
    await expect(owner.acknowledgeException(created.id, actor)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION', statusCode: 400 });
    expect(await fixture.snapshot()).toEqual(before);
  });

  it('resolves with the trimmed note, actual actor, timestamp and history', async () => {
    const created = await owner.upsertException(input);
    const result = await owner.resolveException(created.id, actor, '  Supplier short accepted  ');
    expect(result).toMatchObject({ status: 'resolved', resolvedBy: actor, resolutionNote: 'Supplier short accepted' });
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(await saved(created.id)).toMatchObject({ status: 'resolved', resolved_by: actor, resolved_at: result.resolvedAt, resolution_note: 'Supplier short accepted' });
    const audit = await history();
    expect(audit).toHaveLength(2);
    assertAudit(audit[1], actor, `Exception resolved: qty_short — Short by two pieces. Note: Supplier short accepted (by ${actor})`);
  });

  it('dismisses without an optional note while recording actor, timestamp and history', async () => {
    const created = await owner.upsertException(input);
    const result = await owner.dismissException(created.id, actor);
    expect(result).toMatchObject({ status: 'dismissed', dismissedBy: actor, dismissNote: null });
    expect(result.dismissedAt).toBeInstanceOf(Date);
    expect(await saved(created.id)).toMatchObject({ status: 'dismissed', dismissed_by: actor, dismissed_at: result.dismissedAt, dismiss_note: null });
    const audit = await history();
    expect(audit).toHaveLength(2);
    assertAudit(audit[1], actor, `Exception dismissed: qty_short — Short by two pieces (by ${actor})`);
  });

  it('rejects dismissal of a known resolved row without changing any fixture records', async () => {
    const created = await owner.upsertException(input);
    await owner.resolveException(created.id, actor, 'Supplier short accepted');
    const before = await fixture.snapshot();
    await expect(owner.dismissException(created.id, actor)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION', statusCode: 400 });
    expect(await fixture.snapshot()).toEqual(before);
  });
});
