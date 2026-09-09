import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectWorktreeChanges,
  commitAll,
  createWorktree,
  ensureRepo,
  headSha,
  isRepo,
  status,
} from '../src/git.js';

/**
 * Git integration.
 *
 * These run against a real repository in a temp directory, because the parts
 * that matter — worktree isolation and collecting an agent's work back out of
 * one — cannot be meaningfully faked. Worktree isolation is what keeps
 * "nothing touches your working tree until you accept it" true for CLI agents,
 * which edit files directly.
 */

let root: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-git-test-'));
  fs.writeFileSync(path.join(root, 'existing.ts'), 'export const a = 1;\n');
  await ensureRepo(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureRepo', () => {
  it('initialises a repo with a first commit, so HEAD exists', async () => {
    expect(await isRepo(root)).toBe(true);
    expect(await headSha(root)).toBeTruthy();
  });

  it('is idempotent', async () => {
    const before = await headSha(root);
    expect((await ensureRepo(root)).created).toBe(false);
    expect(await headSha(root)).toBe(before);
  });
});

describe('commitAll', () => {
  it('returns null when there is nothing to commit', async () => {
    // A normal outcome, not an error — callers rely on this.
    expect(await commitAll(root, 'no-op')).toBeNull();
  });

  it('commits new work and returns the sha', async () => {
    fs.writeFileSync(path.join(root, 'new.ts'), 'export const b = 2;\n');
    const sha = await commitAll(root, 'add new.ts');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await status(root)).toEqual([]);
  });
});

describe('worktree isolation', () => {
  it('gives the agent a full checkout of HEAD', async () => {
    const worktree = await createWorktree(root, 'task-1');
    try {
      expect(fs.existsSync(path.join(worktree.dir, 'existing.ts'))).toBe(true);
    } finally {
      await worktree.dispose();
    }
  });

  it('keeps writes inside the worktree out of the real working tree', async () => {
    // This is the property the whole design turns on.
    const worktree = await createWorktree(root, 'task-2');
    try {
      fs.writeFileSync(path.join(worktree.dir, 'agent-wrote-this.ts'), 'export const c = 3;\n');
      expect(fs.existsSync(path.join(root, 'agent-wrote-this.ts'))).toBe(false);
    } finally {
      await worktree.dispose();
    }
    expect(fs.existsSync(path.join(root, 'agent-wrote-this.ts'))).toBe(false);
  });

  it('cleans itself up, leaving no branch behind', async () => {
    const worktree = await createWorktree(root, 'task-3');
    const dir = worktree.dir;
    await worktree.dispose();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('can be disposed twice without throwing', async () => {
    const worktree = await createWorktree(root, 'task-4');
    await worktree.dispose();
    await expect(worktree.dispose()).resolves.toBeUndefined();
  });
});

describe('collectWorktreeChanges', () => {
  it('collects a file the agent created', async () => {
    const worktree = await createWorktree(root, 'task-5');
    try {
      fs.writeFileSync(path.join(worktree.dir, 'created.ts'), 'export const d = 4;\n');
      const changes = await collectWorktreeChanges(worktree.dir);
      expect(changes.files).toEqual([{ path: 'created.ts', content: 'export const d = 4;\n' }]);
      expect(changes.deleted).toEqual([]);
    } finally {
      await worktree.dispose();
    }
  });

  it('collects a file the agent modified, with its new contents', async () => {
    const worktree = await createWorktree(root, 'task-6');
    try {
      fs.writeFileSync(path.join(worktree.dir, 'existing.ts'), 'export const a = 99;\n');
      const changes = await collectWorktreeChanges(worktree.dir);
      expect(changes.files).toHaveLength(1);
      expect(changes.files[0]?.content).toContain('99');
    } finally {
      await worktree.dispose();
    }
  });

  it('collects a file in a new subdirectory', async () => {
    const worktree = await createWorktree(root, 'task-7');
    try {
      fs.mkdirSync(path.join(worktree.dir, 'src', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(worktree.dir, 'src', 'deep', 'x.ts'), 'export const x = 1;\n');
      const changes = await collectWorktreeChanges(worktree.dir);
      expect(changes.files.map((f) => f.path)).toEqual(['src/deep/x.ts']);
    } finally {
      await worktree.dispose();
    }
  });

  it('reports deletions separately rather than applying them', async () => {
    // A reviewer cannot tell "deliberately deleted" from "lost", so a deletion
    // is surfaced in the worklog and never applied automatically.
    const worktree = await createWorktree(root, 'task-8');
    try {
      fs.rmSync(path.join(worktree.dir, 'existing.ts'));
      const changes = await collectWorktreeChanges(worktree.dir);
      expect(changes.deleted).toContain('existing.ts');
      expect(changes.files.map((f) => f.path)).not.toContain('existing.ts');
    } finally {
      await worktree.dispose();
    }
  });

  it("ignores the app's own state directory", async () => {
    const worktree = await createWorktree(root, 'task-9');
    try {
      fs.mkdirSync(path.join(worktree.dir, '.agentic-team'), { recursive: true });
      fs.writeFileSync(path.join(worktree.dir, '.agentic-team', 'noise.json'), '{}');
      fs.writeFileSync(path.join(worktree.dir, 'real.ts'), 'export const r = 1;\n');
      const changes = await collectWorktreeChanges(worktree.dir);
      expect(changes.files.map((f) => f.path)).toEqual(['real.ts']);
    } finally {
      await worktree.dispose();
    }
  });

  it('skips binary output, which cannot be reviewed as a diff', async () => {
    const worktree = await createWorktree(root, 'task-10');
    try {
      fs.writeFileSync(path.join(worktree.dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
      const changes = await collectWorktreeChanges(worktree.dir);
      expect(changes.files.map((f) => f.path)).not.toContain('blob.bin');
    } finally {
      await worktree.dispose();
    }
  });

  it('caps how many files one task can produce, and says it did', async () => {
    const worktree = await createWorktree(root, 'task-11');
    try {
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(worktree.dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
      }
      const changes = await collectWorktreeChanges(worktree.dir, { maxFiles: 3 });
      expect(changes.files).toHaveLength(3);
      expect(changes.truncated).toBe(true);
    } finally {
      await worktree.dispose();
    }
  });

  it('returns nothing when the agent changed nothing', async () => {
    const worktree = await createWorktree(root, 'task-12');
    try {
      const changes = await collectWorktreeChanges(worktree.dir);
      expect(changes.files).toEqual([]);
      expect(changes.truncated).toBe(false);
    } finally {
      await worktree.dispose();
    }
  });
});
