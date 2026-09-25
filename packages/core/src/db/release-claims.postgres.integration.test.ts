import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PostgresAdapter } from './adapters/postgres';
import {
  claimReleaseIssue,
  recordReleaseDeployment,
  recordReleaseMerge,
  releaseReleaseClaim,
} from './release-claims';

const scratchUrl = process.env.ARCHON_TEST_RELEASE_CLAIMS_POSTGRES_URL;

describe.skipIf(!scratchUrl)('release claims on a scratch PostgreSQL database', () => {
  test('competing owners, replay and guarded receipts match SQLite', async () => {
    if (!scratchUrl) throw new Error('Scratch PostgreSQL URL is required');
    const parsed = new URL(scratchUrl);
    if (!parsed.pathname.startsWith('/archon_release_claims_scratch_')) {
      throw new Error('Refusing release claim test outside a named scratch database');
    }
    const first = new PostgresAdapter(scratchUrl);
    const second = new PostgresAdapter(scratchUrl);
    try {
      const conversationId = randomUUID();
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      await first.query(
        `INSERT INTO remote_agent_conversations
        (id, platform_type, platform_conversation_id) VALUES ($1, 'web', $2)`,
        [conversationId, conversationId]
      );
      await first.query(
        `INSERT INTO remote_agent_workflow_runs
        (id, conversation_id, workflow_name, user_message)
        VALUES ($1, $3, 'release', 'scope'), ($2, $3, 'release', 'scope')`,
        [ownerA, ownerB, conversationId]
      );
      const input = {
        repository: 'mhoo-os/archon',
        issueKey: randomUUID(),
        ownerRunId: ownerA,
        scopeDigest: 'scope',
      };
      const competing = { ...input, ownerRunId: ownerB };
      const results = await Promise.allSettled([
        claimReleaseIssue(input, first),
        claimReleaseIssue(competing, second),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const winner = results.find(result => result.status === 'fulfilled');
      if (!winner || winner.status !== 'fulfilled') throw new Error('No claim winner');
      const claim = winner.value;
      const owner = claim.owner_run_id;
      expect((await claimReleaseIssue({ ...input, ownerRunId: owner }, second)).id).toBe(claim.id);
      await expect(
        claimReleaseIssue({ ...input, ownerRunId: owner === ownerA ? ownerB : ownerA }, first)
      ).rejects.toThrow('claimed by another run');
      const receipt = { prNumber: 1, headSha: 'a'.repeat(40), mergeCommit: 'b'.repeat(40) };
      await expect(recordReleaseDeployment(claim.id, owner, first)).rejects.toThrow('merged state');
      expect((await recordReleaseMerge(claim.id, owner, receipt, first)).state).toBe('merged');
      expect((await recordReleaseMerge(claim.id, owner, receipt, second)).state).toBe('merged');
      expect((await recordReleaseDeployment(claim.id, owner, second)).state).toBe('deployed');
      expect((await releaseReleaseClaim(claim.id, owner, 'deployed', first)).state).toBe(
        'released'
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
