import { randomUUID } from 'node:crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';

export type ReleaseClaimState = 'claimed' | 'merged' | 'deployed' | 'released';

export interface ReleaseClaim {
  id: string;
  repository: string;
  issue_key: string;
  owner_run_id: string;
  scope_digest: string;
  state: ReleaseClaimState;
  pr_number: number | null;
  head_sha: string | null;
  merge_commit: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimReleaseIssueInput {
  repository: string;
  issueKey: string;
  ownerRunId: string;
  scopeDigest: string;
}

function normalizedKey(value: string, label: string): string {
  const key = value.trim().toLowerCase();
  if (!key) throw new Error(`${label} cannot be empty`);
  return key;
}

function assertSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be a full lowercase SHA`);
}

export async function claimReleaseIssue(
  input: ClaimReleaseIssueInput,
  db: IDatabase = getDatabase()
): Promise<ReleaseClaim> {
  const repository = normalizedKey(input.repository, 'repository');
  const issueKey = normalizedKey(input.issueKey, 'issue key');
  if (!input.ownerRunId || !input.scopeDigest)
    throw new Error('Claim owner and scope are required');
  const id = randomUUID();
  const result = await db.query<ReleaseClaim>(
    `INSERT INTO remote_agent_release_claims
      (id, repository, issue_key, owner_run_id, scope_digest, state)
     VALUES ($1, $2, $3, $4, $5, 'claimed')
     ON CONFLICT DO NOTHING RETURNING *`,
    [id, repository, issueKey, input.ownerRunId, input.scopeDigest]
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await getReleaseClaim(repository, issueKey, db);
  if (existing?.owner_run_id === input.ownerRunId && existing.scope_digest === input.scopeDigest) {
    return existing;
  }
  if (!existing) {
    const prior = await db.query<ReleaseClaim>(
      `SELECT * FROM remote_agent_release_claims
       WHERE repository = $1 AND issue_key = $2 AND owner_run_id = $3`,
      [repository, issueKey, input.ownerRunId]
    );
    if (prior.rows[0]?.scope_digest === input.scopeDigest) return prior.rows[0];
  }
  throw new Error(`Release issue ${repository}#${issueKey} is claimed by another run or scope`);
}

export async function getReleaseClaim(
  repository: string,
  issueKey: string,
  db: IDatabase = getDatabase()
): Promise<ReleaseClaim | null> {
  const result = await db.query<ReleaseClaim>(
    `SELECT * FROM remote_agent_release_claims
     WHERE repository = $1 AND issue_key = $2
       AND state IN ('claimed', 'merged', 'deployed')`,
    [normalizedKey(repository, 'repository'), normalizedKey(issueKey, 'issue key')]
  );
  return result.rows[0] ?? null;
}

async function transition(
  claimId: string,
  ownerRunId: string,
  from: ReleaseClaimState,
  to: ReleaseClaimState,
  fields: { prNumber?: number; headSha?: string; mergeCommit?: string },
  db: IDatabase
): Promise<ReleaseClaim> {
  const updates = ['state = $4', 'updated_at = CURRENT_TIMESTAMP'];
  const params: unknown[] = [claimId, ownerRunId, from, to];
  if (fields.prNumber !== undefined) {
    updates.push(`pr_number = $${params.length + 1}`);
    params.push(fields.prNumber);
  }
  if (fields.headSha !== undefined) {
    updates.push(`head_sha = $${params.length + 1}`);
    params.push(fields.headSha);
  }
  if (fields.mergeCommit !== undefined) {
    updates.push(`merge_commit = $${params.length + 1}`);
    params.push(fields.mergeCommit);
  }
  const result = await db.query(
    `UPDATE remote_agent_release_claims SET ${updates.join(', ')}
     WHERE id = $1 AND owner_run_id = $2 AND state = $3`,
    params
  );
  const read = await db.query<ReleaseClaim>(
    'SELECT * FROM remote_agent_release_claims WHERE id = $1',
    [claimId]
  );
  const prior = read.rows[0];
  if (result.rowCount === 1 && prior) return prior;
  if (
    prior?.owner_run_id === ownerRunId &&
    prior.state === to &&
    (fields.prNumber === undefined || prior.pr_number === fields.prNumber) &&
    (fields.headSha === undefined || prior.head_sha === fields.headSha) &&
    (fields.mergeCommit === undefined || prior.merge_commit === fields.mergeCommit)
  )
    return prior;
  throw new Error(`Release claim ${claimId} is not owned in ${from} state`);
}

export async function recordReleaseMerge(
  claimId: string,
  ownerRunId: string,
  receipt: { prNumber: number; headSha: string; mergeCommit: string },
  db: IDatabase = getDatabase()
): Promise<ReleaseClaim> {
  if (!Number.isSafeInteger(receipt.prNumber) || receipt.prNumber < 1)
    throw new Error('Invalid PR number');
  assertSha(receipt.headSha, 'PR head');
  assertSha(receipt.mergeCommit, 'Merge commit');
  return transition(claimId, ownerRunId, 'claimed', 'merged', receipt, db);
}

export async function recordReleaseDeployment(
  claimId: string,
  ownerRunId: string,
  db: IDatabase = getDatabase()
): Promise<ReleaseClaim> {
  return transition(claimId, ownerRunId, 'merged', 'deployed', {}, db);
}

export async function releaseReleaseClaim(
  claimId: string,
  ownerRunId: string,
  state: Exclude<ReleaseClaimState, 'released'>,
  db: IDatabase = getDatabase()
): Promise<ReleaseClaim> {
  return transition(claimId, ownerRunId, state, 'released', {}, db);
}
