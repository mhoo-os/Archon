import { afterEach, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as git from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

const roots: string[] = [];
const environments = new Map<
  string,
  {
    id: string;
    working_path: string;
    branch_name: string;
    metadata: Record<string, unknown>;
  }
>();
let createCount = 0;

mock.module('@archon/isolation', () => ({
  configureIsolation: () => undefined,
  classifyIsolationError: (error: Error) => error.message,
  getIsolationProvider: () => ({
    create: async (request: { identifier: string; canonicalRepoPath: string }) => {
      createCount++;
      const branchName = `archon/task-${request.identifier}`;
      const workingPath = join(dirname(request.canonicalRepoPath), 'worktrees', request.identifier);
      const adopted = existsSync(workingPath);
      if (!adopted) {
        await git.execFileAsync('git', [
          '-C',
          request.canonicalRepoPath,
          'worktree',
          'add',
          '-b',
          branchName,
          workingPath,
          'dev',
        ]);
      }
      return { workingPath, branchName, metadata: { adopted } };
    },
  }),
}));

mock.module('../db/isolation-environments', () => ({
  findActiveByWorkflow: async (_codebase: string, _type: string, identifier: string) =>
    environments.get(identifier) ?? null,
  create: async (input: {
    workflow_id: string;
    working_path: string;
    branch_name: string;
    metadata: Record<string, unknown>;
  }) => {
    const row = {
      id: `env-${input.workflow_id}`,
      working_path: input.working_path,
      branch_name: input.branch_name,
      metadata: input.metadata,
    };
    environments.set(input.workflow_id, row);
    return row;
  },
}));

const { createChildWorktreeResolver } = await import('./child-isolation-resolver');

afterEach(async () => {
  environments.clear();
  createCount = 0;
  for (const root of roots.splice(0)) await removeTempTree(root);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'archon-iteration-estate-'));
  roots.push(root);
  const repo = join(root, 'repo');
  await git.execFileAsync('git', ['init', '-b', 'dev', repo]);
  await git.execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Archon Test']);
  await git.execFileAsync('git', [
    '-C',
    repo,
    'config',
    'user.email',
    'archon-test@example.invalid',
  ]);
  await writeFile(join(repo, 'seed.txt'), 'seed\n');
  await git.execFileAsync('git', ['-C', repo, 'add', 'seed.txt']);
  await git.execFileAsync('git', ['-C', repo, 'commit', '-qm', 'seed']);
  const resolver = createChildWorktreeResolver({
    codebaseId: 'codebase',
    codebaseName: 'owner/repo',
    canonicalRepoPath: repo,
    baseBranch: 'dev',
    createdByPlatform: 'cli',
  });
  const parentRun = { id: '11111111-2222-3333-4444-555555555555' } as WorkflowRun;
  const request = { parentRun, groupPath: 'issues', iteration: 1, sourceDigest: 'capture-sha' };
  if (!resolver.resolveIteration) throw new Error('Iteration resolver unavailable');
  return { repo, request, resolve: resolver.resolveIteration };
}

test('reconciles creation before the binding event and keeps registered dirty work', async () => {
  const { request, resolve } = await fixture();
  const first = await resolve(request);
  const listed = (
    await git.listWorktrees(git.toRepoPath(dirname(dirname(first.cwd)) + '/repo'))
  ).find(worktree => worktree.branch === first.branchName);
  expect(listed).toBeDefined();
  expect(await realpath(listed!.path)).toBe(await realpath(first.cwd));
  await writeFile(join(first.cwd, 'unfinished.txt'), 'uncommitted work\n');
  const recoveredBeforeEvent = await resolve(request);
  expect(recoveredBeforeEvent).toEqual(first);
  expect(createCount).toBe(2);
  expect(await Bun.file(join(first.cwd, 'unfinished.txt')).text()).toBe('uncommitted work\n');
  const recorded = await resolve({ ...request, recorded: first });
  expect(recorded).toEqual(first);
  expect(createCount).toBe(2);
});

test('holds a recorded estate when its checkout is missing or moved', async () => {
  const { repo, request, resolve } = await fixture();
  const recorded = await resolve(request);
  const moved = join(dirname(recorded.cwd), 'moved');
  await git.execFileAsync('git', ['-C', repo, 'worktree', 'move', recorded.cwd, moved]);
  await expect(resolve({ ...request, recorded })).rejects.toThrow(
    'missing or moved ownership evidence'
  );
  await git.execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', moved]);
  await expect(resolve({ ...request, recorded })).rejects.toThrow(
    'missing or moved ownership evidence'
  );
  expect(createCount).toBe(1);
});
