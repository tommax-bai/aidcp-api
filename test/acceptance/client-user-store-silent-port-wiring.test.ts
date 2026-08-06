// aidcp:test-owner=derived
// 它读的是**本仓手写的组装根**（`src/server.ts`），在 aidcp-cloud 里没有对应物；
// 没有这行标记，跨仓同步会把它当成「多出的文件」，`--prune` 一跑就没了。
/**
 * 「端口缺席即当成成功」的可选端口，组装根 MUST 接上。
 *
 * ## 它防的是什么
 *
 * `ClientUserStore` 有一类可选端口，缺席时的实现是**直接返回成功**：
 *
 * ```ts
 * private async refreshFacebookOperationPolicyAfterProvisioning(): Promise<boolean> {
 *   if (!this.refreshFacebookOperationPolicyAuthority) return true;   // ← 这一行
 * ```
 *
 * 也就是说：单体在组装根接着的那一格，派生仓自己写 main 时漏掉，
 * **编译过、单测全绿、启动无告警、运行时无日志**——功能安静地消失。
 * 这正是拆仓红线里「静默假成功」的形态，`mirror-bump-wiring` 那道闸治的是同一个病的另一个器官。
 *
 * ## 已经付过的代价（2026-08-06 dev 实测）
 *
 * 掉的那一格是「建号 / 导入落库提交后，当场重装本进程的运行策略副本」。漏接之后：
 *   ① 新环境的主浏览入口只能等配置镜像那条 **5 秒轮询**兜底收进副本；
 *   ② 副本没收进去时，「这个环境按什么方式跑」一律答
 *      `facebook_operation_policy_unavailable`(503)；
 *   ③ 客户端恰恰是在建号回执落地那一刻就去问的 —— 必落在窗口里；
 *   ④ 客户端把这次失败按环境钉死、不再重取 ⇒ 那行错误一直挂到重启客户端。
 * yn50 一批导入 50 个 Facebook 环境，50 个全中。
 *
 * ## 为什么不钉一张名单
 *
 * 覆盖面 MUST 从**事实源**读出来：凡是写成「端口缺席 → 返回成功」的可选端口，
 * 都是在说「我这一格漏了不会有任何东西说出来」。手抄名单的话，下一个同形状的端口不在名单里，
 * 闸对它全绿 —— 那正是「守卫只覆盖作者当时在治的那条道」。本闸因此先从存储类源码读出这批端口名，
 * 再回到组装根逐个核。今天读出来是一个；多一个自动进闸。
 *
 * ## 例外怎么写
 *
 * {@link DELIBERATELY_UNWIRED}：逐条写清**为什么本进程不需要这个端口**，且理由必须是结构性的
 * （「这条路在本进程根本走不到」而不是「今天还没人用」）。今天是空的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const STORE_URL = new URL('../../src/client-auth/client-user-store.ts', import.meta.url);
const ROOT_URL = new URL('../../src/server.ts', import.meta.url);

/** 本进程刻意不接的端口，逐条写清结构性理由。今天是空的。 */
const DELIBERATELY_UNWIRED: Readonly<Record<string, string>> = {};

/**
 * 结构断言一律读**剥掉注释**的源码。
 *
 * 本文件上面那段说明里就带着端口名，组装根那一格的注释里也带着 ——
 * 按原文匹配的话，把接线删掉、只留注释，闸照样全绿：**闸恒真 = 闸不在**。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** 事实源：缺席时直接返回「成功」的可选端口名。 */
function silentlyOptionalPorts(source: string): string[] {
  const found = new Set<string>();
  const pattern = /if\s*\(\s*!this\.([A-Za-z0-9_]+)\s*\)\s*return\s+true\s*;/g;
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found].sort();
}

/** 组装根里 `new ClientUserStore({ … })` 那个对象字面量（含首尾大括号）。 */
function clientUserStoreBlock(source: string): string {
  const marker = 'new ClientUserStore({';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, '组装根 MUST 自己构造 ClientUserStore');
  assert.equal(
    source.indexOf(marker, start + 1),
    -1,
    '组装根里只该有一处 ClientUserStore 构造；多处时本闸只核第一处 = 漏核',
  );
  let depth = 0;
  for (let i = start + marker.length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail('ClientUserStore 构造块的大括号没有闭合');
}

test('组装根接上了 ClientUserStore 每一个「缺席即假装成功」的端口', async () => {
  const storeSource = stripComments(await readFile(STORE_URL, 'utf8'));
  const rootSource = stripComments(await readFile(ROOT_URL, 'utf8'));
  const ports = silentlyOptionalPorts(storeSource);

  assert.ok(
    ports.length > 0,
    '一个都没读出来 ⇒ 事实源的写法变了、本闸已经在空转（而不是「已经没有这类端口了」）',
  );

  const block = clientUserStoreBlock(rootSource);
  for (const port of ports) {
    if (port in DELIBERATELY_UNWIRED) continue;
    assert.match(
      block,
      new RegExp(`(^|[^A-Za-z0-9_])${port}\\s*:`),
      `组装根漏接 ${port}：这个端口缺席时存储会**直接返回成功**，`
        + '漏掉不报错、不告警、无日志，只有真跑才现形',
    );
  }
});

test('运行策略副本那一格接的是真刷新，不是一个应付闸的空实现', async () => {
  const rootSource = stripComments(await readFile(ROOT_URL, 'utf8'));
  const block = clientUserStoreBlock(rootSource);
  const wiring = /refreshFacebookOperationPolicyAuthority\s*:[\s\S]*?refreshFromAuthority\s*\(/;
  assert.match(
    block,
    wiring,
    '这一格 MUST 落到运行策略存储的 refreshFromAuthority()；'
      + '接一个不刷新的实现与漏接同义（客户端照样在建号后读到 503）',
  );
});
