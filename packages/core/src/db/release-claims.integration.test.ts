import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { removeTempTree } from '@archon/paths/test-utils';
import { SqliteAdapter } from './adapters/sqlite';
import {
  claimReleaseIssue,
  getReleaseClaim,
  recordReleaseDeployment,
  recordReleaseMerge,
  releaseReleaseClaim,
} from './release-claims';

const roots: string[] = [];
const openAdapters: SqliteAdapter[] = [];

afterEach(async () => {
  for (const adapter of openAdapters.splice(0)) await adapter.close();
  for (const root of roots.splice(0)) await removeTempTree(root);
});

async function fixture(): Promise<[SqliteAdapter, SqliteAdapter]> {
  const root = await mkdtemp(join(tmpdir(), 'archon-release-claims-'));
  roots.push(root);
  const path = join(root, 'archon.db');
  const first = new SqliteAdapter(path);
  const second = new SqliteAdapter(path);
  openAdapters.push(first, second);
  await first.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ('conv', 'web', 'conv')`
  );
  for (const id of ['owner-a', 'owner-b']) {
    await first.query(
      `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message)
       VALUES ($1, 'conv', 'release', 'scope')`,
      [id]
    );
  }
  return [first, second];
}

test('competing connections have one owner, including after a pause or restart', async () => {
  const [first, second] = await fixture();
  const a = {
    repository: ' Mhoo-OS/Archon ',
    issueKey: 'MHO-299',
    ownerRunId: 'owner-a',
    scopeDigest: 'scope-a',
  };
  const b = { ...a, ownerRunId: 'owner-b' };
  const outcomes = await Promise.allSettled([
    claimReleaseIssue(a, first),
    claimReleaseIssue(b, second),
  ]);
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
  const winner =
    outcomes[0]?.status === 'fulfilled'
      ? outcomes[0].value
      : (outcomes[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimReleaseIssue>>>)
          .value;
  const winnerInput = winner.owner_run_id === 'owner-a' ? a : b;
  const loserInput = winner.owner_run_id === 'owner-a' ? b : a;
  expect((await claimReleaseIssue(winnerInput, second)).id).toBe(winner.id);
  await first.query("UPDATE remote_agent_workflow_runs SET status = 'paused' WHERE id = $1", [
    winner.owner_run_id,
  ]);
  await expect(claimReleaseIssue(loserInput, first)).rejects.toThrow('claimed by another run');
  expect((await getReleaseClaim('mhoo-os/archon', 'mho-299', second))?.id).toBe(winner.id);
});

test('merge and deployment receipts require the exact owner and prior state', async () => {
  const [db] = await fixture();
  const claim = await claimReleaseIssue(
    { repository: 'mhoo-os/archon', issueKey: '299', ownerRunId: 'owner-a', scopeDigest: 'scope' },
    db
  );
  const headSha = 'a'.repeat(40);
  const mergeCommit = 'b'.repeat(40);
  await expect(recordReleaseDeployment(claim.id, 'owner-a', db)).rejects.toThrow('merged state');
  await expect(
    recordReleaseMerge(claim.id, 'owner-b', { prNumber: 1, headSha, mergeCommit }, db)
  ).rejects.toThrow('claimed state');
  const merged = await recordReleaseMerge(
    claim.id,
    'owner-a',
    { prNumber: 1, headSha, mergeCommit },
    db
  );
  expect([merged.state, merged.pr_number, merged.head_sha, merged.merge_commit]).toEqual([
    'merged',
    1,
    headSha,
    mergeCommit,
  ]);
  expect(
    (await recordReleaseMerge(claim.id, 'owner-a', { prNumber: 1, headSha, mergeCommit }, db)).id
  ).toBe(claim.id);
  await expect(
    recordReleaseMerge(claim.id, 'owner-a', { prNumber: 2, headSha, mergeCommit }, db)
  ).rejects.toThrow('claimed state');
  await expect(releaseReleaseClaim(claim.id, 'owner-b', 'merged', db)).rejects.toThrow('merged');
  expect((await recordReleaseDeployment(claim.id, 'owner-a', db)).state).toBe('deployed');
  expect((await recordReleaseDeployment(claim.id, 'owner-a', db)).state).toBe('deployed');
  expect((await releaseReleaseClaim(claim.id, 'owner-a', 'deployed', db)).state).toBe('released');
  expect((await releaseReleaseClaim(claim.id, 'owner-a', 'deployed', db)).state).toBe('released');
  const replay = await claimReleaseIssue(
    { repository: 'mhoo-os/archon', issueKey: '299', ownerRunId: 'owner-a', scopeDigest: 'scope' },
    db
  );
  expect([replay.id, replay.state]).toEqual([claim.id, 'released']);
  const next = await claimReleaseIssue(
    {
      repository: 'mhoo-os/archon',
      issueKey: '299',
      ownerRunId: 'owner-b',
      scopeDigest: 'next-scope',
    },
    db
  );
  expect(next.id).not.toBe(claim.id);
});

test('claims work after upgrading the shipped v0.10 SQLite schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archon-release-upgrade-'));
  roots.push(root);
  const path = join(root, 'archon.db');
  const legacy = new Database(path);
  try {
    legacy.exec(
      await Bun.file(join(import.meta.dir, 'fixtures/sqlite-vintages/v0.10.0.sql')).text()
    );
  } finally {
    legacy.close();
  }
  const db = new SqliteAdapter(path);
  openAdapters.push(db);
  await db.query(`INSERT INTO remote_agent_conversations
    (id, platform_type, platform_conversation_id) VALUES ('conv', 'web', 'conv')`);
  await db.query(`INSERT INTO remote_agent_workflow_runs
    (id, conversation_id, workflow_name, user_message)
    VALUES ('owner-a', 'conv', 'release', 'scope'), ('owner-b', 'conv', 'release', 'scope')`);
  const input = {
    repository: 'mhoo-os/archon',
    issueKey: '299',
    ownerRunId: 'owner-a',
    scopeDigest: 'scope',
  };
  expect((await claimReleaseIssue(input, db)).state).toBe('claimed');
  await expect(claimReleaseIssue({ ...input, ownerRunId: 'owner-b' }, db)).rejects.toThrow(
    'claimed by another run'
  );
});
