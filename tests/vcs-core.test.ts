import { describe, it, expect } from 'vitest';
import {
  sha256, fastHash, validPath, ancestors, mergeCheck, fastForward, rebase, createCommit, VcsError,
} from '../packages/vcs-core/src/index';
import { makeRepository } from '../apps/api/src/seed';
import type { User } from '../packages/shared/src/index';

const user: User = { id: 'u1', name: 'Ada', email: 'ada@velocity.dev', passwordHash: 'x' };
const other: User = { id: 'u2', name: 'Linus', email: 'linus@velocity.dev', passwordHash: 'x' };
const repo = () => makeRepository('demo', user);

describe('hashing', () => {
  it('sha256 is stable and 64 hex chars', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
    expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('hello')).not.toBe(sha256('world'));
  });
  it('fastHash is an 8-char hex fingerprint that changes with content', () => {
    expect(fastHash('a')).toMatch(/^[0-9a-f]{8}$/);
    expect(fastHash('a')).not.toBe(fastHash('b'));
  });
});

describe('validPath', () => {
  it('accepts normal repo paths', () => {
    expect(validPath('src/index.ts')).toBe('src/index.ts');
  });
  it('rejects traversal, absolute, backslash and vcs-internal paths', () => {
    for (const p of ['../etc/passwd', '/abs', 'a\\b', 'a/../b', '.git/config', '.velocity/HEAD']) {
      expect(() => validPath(p)).toThrow(VcsError);
    }
  });
});

describe('createCommit', () => {
  it('records insertions and a deterministic content hash', () => {
    const r = repo();
    const c = createCommit(r, { message: 'init', branch: 'main', files: { 'a.txt': 'one\ntwo' } }, user);
    expect(c.insertions).toBe(2);
    expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.branches.find(b => b.name === 'main')!.currentHead).toBe(c.id);
  });
  it('counts deletions when a file is removed', () => {
    const r = repo();
    createCommit(r, { message: 'init', branch: 'main', files: { 'a.txt': 'x\ny\nz\n' } }, user);
    const c = createCommit(r, { message: 'drop', branch: 'main', files: { 'a.txt': null } }, user);
    expect(c.deletions).toBeGreaterThanOrEqual(3);
    expect(c.changedPaths).toContain('a.txt');
  });
  it('rejects an empty commit', () => {
    const r = repo();
    createCommit(r, { message: 'init', branch: 'main', files: { 'a.txt': 'same' } }, user);
    expect(() => createCommit(r, { message: 'noop', branch: 'main', files: { 'a.txt': 'same' } }, user)).toThrow(/clean/i);
  });
  it('enforces optimistic concurrency via expectedHead', () => {
    const r = repo();
    createCommit(r, { message: 'init', branch: 'main', files: { 'a.txt': '1' } }, user);
    expect(() => createCommit(r, { message: 'stale', branch: 'main', expectedHead: null, files: { 'a.txt': '2' } }, user)).toThrow(/pull/i);
  });
});

describe('history + merge', () => {
  it('ancestors walks the linear parent chain newest-first', () => {
    const r = repo();
    const a = createCommit(r, { message: 'a', branch: 'main', files: { 'f': '1' } }, user);
    const b = createCommit(r, { message: 'b', branch: 'main', files: { 'f': '2' } }, user);
    expect(ancestors(r, b.id)).toEqual([b.id, a.id]);
  });
  it('fast-forwards develop up to main when it has not diverged', () => {
    const r = repo();
    createCommit(r, { message: 'a', branch: 'main', files: { 'f': '1' } }, user);
    const check = mergeCheck(r, 'main', 'develop');
    expect(check.canFastForward).toBe(true);
    fastForward(r, 'main', 'develop', user.name);
    expect(r.branches.find(b => b.name === 'develop')!.currentHead).toBe(r.branches.find(b => b.name === 'main')!.currentHead);
  });
  it('refuses a fast-forward when branches diverge and rebase replays commits', () => {
    const r = repo();
    createCommit(r, { message: 'base', branch: 'main', files: { 'f': '1' } }, user);
    r.branches.find(b => b.name === 'develop')!.currentHead = r.branches.find(b => b.name === 'main')!.currentHead;
    createCommit(r, { message: 'main moves', branch: 'main', files: { 'main-only.txt': 'm' } }, user);
    createCommit(r, { message: 'feature', branch: 'develop', files: { 'feature.txt': 'f' } }, other);
    expect(mergeCheck(r, 'develop', 'main').canFastForward).toBe(false);
    const result = rebase(r, 'develop', 'main', other);
    expect(result.replayed).toBeGreaterThan(0);
    expect(mergeCheck(r, 'develop', 'main').canFastForward).toBe(true);
  });
});
