import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { RestrictedPolicyPatchInput, RestrictedPolicyView } from '../src/panel/types.js';

/**
 * change restricted-policy-global-config：GET/PUT /api/restricted-policy 面板透传。
 * owner（automation facade）负责取值校验与写后真态；本层只做类型拦截 + 503 缺席具名。
 */

const silentLogger = { log() {}, warn() {}, error() {} };

const baseDeps = {
  edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
  eventBus: { onAny: () => () => {} },
  panelStore: {},
};

function makeConfig(over: Partial<PanelConfig> = {}): PanelConfig {
  return { port: 0, jwtSecret: 'test-secret', users: parsePanelUsers('alice:pw1'), jwtTtlSeconds: 3600, forbiddenPorts: [8787, 5432, 8788], logger: silentLogger, ...over };
}

async function login(base: string): Promise<{ authorization: string }> {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'pw1' }) });
  const { token } = (await r.json()) as { token: string };
  return { authorization: `Bearer ${token}` };
}

const defaultView: RestrictedPolicyView = {
  mode: 'browse_only',
  recoveryHours: 72,
  overridden: false,
  updatedAt: null,
  updatedBy: null,
};

test('restricted-policy：GET 回 owner 真态；PUT 透传 patch + 审计人、回写后真态', async () => {
  const calls: Array<[RestrictedPolicyPatchInput, string]> = [];
  const written: RestrictedPolicyView = {
    mode: 'full_pause',
    recoveryHours: 24,
    overridden: true,
    updatedAt: '2026-08-06T00:00:00.000Z',
    updatedBy: 'alice',
  };
  const deps = {
    ...baseDeps,
    restrictedPolicy: {
      getView: async () => defaultView,
      set: async (patch: RestrictedPolicyPatchInput, updatedBy: string) => {
        calls.push([patch, updatedBy]);
        return { ok: true as const, view: written };
      },
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const r = await fetch(`${base}/api/restricted-policy`, { headers: auth });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), defaultView);

    const put = await fetch(`${base}/api/restricted-policy`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'full_pause', recoveryHours: 24 }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), written);
    assert.deepEqual(calls, [[{ mode: 'full_pause', recoveryHours: 24 }, 'alice']], '审计人来自登录态，不来自请求体');
  } finally {
    await h.close();
  }
});

test('restricted-policy：owner 拒非法值 → 400 invalid_value；类型错在本层拦 → 400 bad_request', async () => {
  const deps = {
    ...baseDeps,
    restrictedPolicy: {
      getView: async () => defaultView,
      set: async () => ({ ok: false as const, reason: 'invalid_value' as const }),
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const bad = await fetch(`${base}/api/restricted-policy`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'nuke_from_orbit' }),
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_value' });

    const typeErr = await fetch(`${base}/api/restricted-policy`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryHours: '24' }),
    });
    assert.equal(typeErr.status, 400);
    assert.deepEqual(await typeErr.json(), { error: 'bad_request', reason: 'value_type' });
  } finally {
    await h.close();
  }
});

test('restricted-policy：能力未注入 → 503 具名缺席（绝不编一份默认回显）', async () => {
  const deps = { ...baseDeps } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    for (const method of ['GET', 'PUT'] as const) {
      const r = await fetch(`${base}/api/restricted-policy`, {
        method,
        headers: { ...auth, 'content-type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify({ recoveryHours: 24 }) } : {}),
      });
      assert.equal(r.status, 503, `${method} 未注入必须 503`);
      assert.deepEqual(await r.json(), { error: 'restricted_policy_unavailable' });
    }
  } finally {
    await h.close();
  }
});
