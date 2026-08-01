// aidcp:test-owner=derived
/**
 * content 进程要用、事实源在本域的两条窄读口（change split-cloud-automation-production-runtime，A-3）。
 *
 * **本文件钉的是「接线在场」，不是「传输件能用」。** 那两条 route 的三件套本身早就有测试；
 * 出事的地方是 api 这个手写 main **从来没注册过它们** —— 单体在 startContentReadApi 里注册，
 * 派生栈里没人接。后果不是报错：对端读失败 → 调用点回落 env → 表现成「库里本来就没配」。
 *
 * 所以下面三条各管一段，缺哪一段这个洞都能原样再出现一次：
 *   ① 注册了就真能往返（传输层没问题）；
 *   ② 没注册时传输层是**响亮**的（说明信号只可能丢在调用方的 catch 里，而不是这一层）；
 *   ③ api 的组装根里那两行注册**必须还在**。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  InternalHttpClient,
  InternalHttpServer,
} from 'aidcp-transport/transport/internal-http.js';
import {
  PROVIDER_SECRET_ROUTES,
  ProviderSecretHttpClient,
  registerProviderSecretRoutes,
} from 'aidcp-transport/transport/provider-secret-http.js';
import {
  ROLE_MODEL_SELECTION_ROUTES,
  RoleModelSelectionHttpClient,
  registerRoleModelSelectionRoutes,
} from 'aidcp-transport/transport/role-model-selection-http.js';

async function withServer(
  wire: (server: InternalHttpServer) => void,
  run: (http: InternalHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  wire(server);
  const port = await server.listen(0);
  try {
    await run(new InternalHttpClient(`http://127.0.0.1:${port}`));
  } finally {
    await server.close();
  }
}

test('两条窄读口注册后逐字段往返（密钥明文与预解析快照都不丢）', async () => {
  const asked: Array<[string, string]> = [];
  await withServer(
    (server) => {
      registerProviderSecretRoutes(server, {
        getSecretForRuntime: async (provider, field) => {
          asked.push([provider, field]);
          return provider === 'dashscope' ? 'plaintext-key' : null;
        },
      });
      registerRoleModelSelectionRoutes(server, {
        fetchRoleModelSelections: async () => ({
          fallback: { provider: 'dashscope', model: 'global-model' },
          byRole: {
            comment_reviewer: {
              provider: 'volcengine',
              model: 'role-model',
              temperature: 0.7,
              thinkingMode: 'on',
            },
          },
        }),
      });
    },
    async (http) => {
      const secrets = new ProviderSecretHttpClient(http);
      assert.equal(await secrets.getSecretForRuntime('dashscope', 'dashscope_api_key'), 'plaintext-key');
      // 「库里没这一项」是 null，**不是**异常 —— 两者分开是调用方唯一的判据。
      assert.equal(await secrets.getSecretForRuntime('oss', 'access_key_id'), null);
      assert.deepEqual(asked, [
        ['dashscope', 'dashscope_api_key'],
        ['oss', 'access_key_id'],
      ]);

      const roles = new RoleModelSelectionHttpClient(http);
      const snapshot = await roles.fetchRoleModelSelections();
      assert.deepEqual(snapshot.fallback, { provider: 'dashscope', model: 'global-model' });
      assert.deepEqual(snapshot.byRole.comment_reviewer, {
        provider: 'volcengine',
        model: 'role-model',
        temperature: 0.7,
        thinkingMode: 'on',
      });
    },
  );
});

test('未注册时传输层如实抛 —— 信号只可能丢在调用方的 catch 里', async () => {
  await withServer(
    () => {
      /* 故意一条都不注册：复现本次修的那个状态 */
    },
    async (http) => {
      const secrets = new ProviderSecretHttpClient(http);
      await assert.rejects(
        () => secrets.getSecretForRuntime('dashscope', 'dashscope_api_key'),
        (err: Error) => {
          assert.match(`${err.message}${JSON.stringify(err)}`, /route_not_found|no route/);
          return true;
        },
        '漏注册 MUST 抛。它一旦悄悄回 null，调用方就再也分不出「读失败」和「库里没配」',
      );
      const roles = new RoleModelSelectionHttpClient(http);
      await assert.rejects(() => roles.fetchRoleModelSelections());
    },
  );
});

test('api 组装根 MUST 注册这两条 —— 复发断言', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  // 直接钉调用表达式，而不是 import 说明符：import 留着、注册删掉，正是本次出事的形态。
  assert.ok(
    source.includes('registerRoleModelSelectionRoutes(server, root.contentReads.roleModelSelectionSource)'),
    'src/server.ts 必须把角色模型解析取源注册成 route，否则 content 侧镜像永远刷新失败、只能用保守默认',
  );
  assert.ok(
    source.includes('registerProviderSecretRoutes(server, root.contentReads.providerSecretReader)'),
    'src/server.ts 必须把厂商密钥窄读注册成 route，否则 content 侧库内密钥读必失败、静默回落 env',
  );

  // 路由名以传输件的常量为准；这里只确认两侧用的是同一份常量，不再手抄字面量。
  assert.equal(PROVIDER_SECRET_ROUTES.getSecretForRuntime, 'provider-secret/get-for-runtime');
  assert.equal(ROLE_MODEL_SELECTION_ROUTES.fetch, 'role-model-selection/fetch');
});
