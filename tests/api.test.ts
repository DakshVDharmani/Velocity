import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import request from 'supertest';
import { openStore, type Store } from '../apps/api/src/store';
import { createApp } from '../apps/api/src/app';

const secret = 'test-secret-that-is-definitely-long-enough-000';
const dataDir = join(tmpdir(), `velocity-test-${randomUUID()}`);
let store: Store;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  store = await openStore({ file: join(dataDir, 'workspace.json'), seed: true });
  app = createApp(store, { secret, demo: true, origin: 'http://localhost:5173', storagePath: join(dataDir, 'objects') });
});
afterAll(async () => {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

const origin = { Origin: 'http://localhost:5173' };

describe('auth', () => {
  it('health endpoint is public', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });
  it('rejects unauthenticated access to repositories', async () => {
    expect((await request(app).get('/api/repositories')).status).toBe(401);
  });
  it('registers, then returns the current user from the session cookie', async () => {
    const agent = request.agent(app);
    const reg = await agent.post('/api/auth/register').set(origin)
      .send({ name: 'Grace Hopper', email: 'grace@velocity.dev', password: 'compiler-1952' });
    expect(reg.status).toBe(201);
    expect(reg.body.data.email).toBe('grace@velocity.dev');
    expect(reg.body.data).not.toHaveProperty('passwordHash');
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.name).toBe('Grace Hopper');
  });
  it('rejects a wrong password', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set(origin)
      .send({ name: 'Test Two', email: 'two@velocity.dev', password: 'correct-horse-battery' });
    const bad = await request(app).post('/api/auth/login').set(origin)
      .send({ email: 'two@velocity.dev', password: 'wrong-password-here' });
    expect(bad.status).toBe(401);
  });
});

describe('repositories', () => {
  let agent: ReturnType<typeof request.agent>;
  beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/api/auth/register').set(origin)
      .send({ name: 'Repo Owner', email: 'owner@velocity.dev', password: 'a-strong-passphrase' });
  });

  it('creates a repository with default branches and commits to it', async () => {
    const created = await agent.post('/api/repositories').set(origin)
      .send({ name: 'service-x', defaultBranch: 'main' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.branches.map((b: { name: string }) => b.name)).toContain('main');

    const commit = await agent.post(`/api/repositories/${id}/commits`).set(origin)
      .send({ message: 'initial commit', branch: 'main', files: { 'README.md': '# service-x\n' } });
    expect(commit.status).toBe(200);
    expect(commit.body.data.hash).toMatch(/^[0-9a-f]{64}$/);

    const commits = await agent.get(`/api/repositories/${id}/commits`);
    expect(commits.body.data[0].message).toBe('initial commit');

    const files = await agent.get(`/api/repositories/${id}/files?branch=main`);
    expect(Object.keys(files.body.data)).toContain('README.md');
  });

  it('blocks a cross-origin write', async () => {
    const res = await agent.post('/api/repositories').set({ Origin: 'https://evil.example' })
      .send({ name: 'nope' });
    expect(res.status).toBe(403);
  });

  it('rejects a duplicate repository name for the same owner', async () => {
    await agent.post('/api/repositories').set(origin).send({ name: 'dupe' });
    const again = await agent.post('/api/repositories').set(origin).send({ name: 'dupe' });
    expect(again.status).toBe(409);
  });

  it('creates a branch and reports fast-forward merge status', async () => {
    const repo = (await agent.post('/api/repositories').set(origin).send({ name: 'branchy' })).body.data;
    await agent.post(`/api/repositories/${repo.id}/commits`).set(origin)
      .send({ message: 'base', branch: 'main', files: { 'a.txt': '1' } });
    const branch = await agent.post(`/api/repositories/${repo.id}/branches`).set(origin)
      .send({ name: 'feature/x', from: 'main' });
    expect(branch.status).toBe(200);
    const check = await agent.post(`/api/repositories/${repo.id}/merge/check`).set(origin)
      .send({ source: 'main', target: 'feature/x' });
    expect(check.body.data.canFastForward).toBe(true);
  });
});
