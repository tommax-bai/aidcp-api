// aidcp:test-owner=derived
// 它读的是**本仓手写的组装根**（`src/server.ts`），在 aidcp-cloud 里没有对应物；
// 没有这行标记，跨仓同步会把它当成「多出的文件」，`--prune` 一跑就没了。
/**
 * `ClientUserStore` 每一个**带缺席判断的可选端口**，组装根 MUST 接上。
 *
 * ## 它防的是什么
 *
 * 这个存储的跨域端口都是可选构造参数，各自在取用处写了一句缺席判断。两种写法，同一个病：
 *
 * ```ts
 * if (!this.refreshFacebookOperationPolicyAuthority) return true;               // 缺席即「成功」
 * if (!this.offboardMaterialization) throw new Error('..._not_configured');     // 缺席即抛
 * ```
 *
 * 单体在组装根接着的那几格，派生仓自己写 main 时漏掉，**编译过、单测全绿、启动无告警**。
 * 这正是拆仓红线里「静默假成功」的形态，`mirror-bump-wiring` 那道闸治的是同一个病的另一个器官。
 *
 * **「缺席即抛」并不等于「漏了会被发现」**：抛出去之后有没有人听得见，取决于调用点。
 * 本仓已经付过两次不同形状的代价（2026-08-06 dev 实测）：
 *   - 运行策略副本刷新（缺席即「成功」）：新建 / 导入的 Facebook 环境只能等配置镜像 5 秒轮询
 *     才进副本，而客户端恰在建号回执落地那一刻就问「这个环境按什么方式跑」——
 *     必落在窗口里，答 503，且客户端把失败按环境钉死不再重取。50 个导入环境 50 个中。
 *   - 离场台账物化（缺席即抛）：调用点把异常收进 try/catch，退成「已受理、等对账」——
 *     那条降级路径本身是设计好的，于是**每一次删环境**都慢一拍，而没有任何东西报错。
 *   - 清理授权签发 / 烧票（缺席即抛）：调用点没有兜底，客户端直接 500。
 *
 * ## 为什么不钉一张名单
 *
 * 覆盖面 MUST 从**事实源**读出来：凡是写了缺席判断的可选端口，都是在说「我这一格可以没有」。
 * 手抄名单的话，下一个端口不在名单里，闸对它全绿 —— 那正是「守卫只覆盖作者当时在治的那条道」。
 * 本闸因此先从存储类源码读出这批端口（字段名 → 构造参数名也一并从构造函数里读），再回到组装根逐个核。
 *
 * ## 例外怎么写
 *
 * {@link DELIBERATELY_UNWIRED}：逐条写清**为什么本进程不需要这个端口**，理由必须是结构性的
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
 * 本文件上面那段说明里就带着端口名，组装根那几格的注释里也带着 ——
 * 按原文匹配的话，把接线删掉、只留注释，闸照样全绿：**闸恒真 = 闸不在**。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** 事实源①：写了缺席判断的私有字段（缺席即「成功」，或缺席即抛）。 */
function guardedFields(source: string): string[] {
  const found = new Set<string>();
  const pattern = /if\s*\(\s*!this\.([A-Za-z0-9_]+)\s*\)\s*(?:return\s+true\s*;|throw\b)/g;
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found].sort();
}

/**
 * 事实源②：构造函数里的 `this.<字段> = options.<参数>`。
 * **字段名与构造参数名并不总是同一个**（`cleanupGrantOperations` ← `cleanupGrantOps`），
 * 按字段名去组装根里找会漏判成「已接」。
 */
function optionByField(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = /this\.([A-Za-z0-9_]+)\s*=\s*options\.([A-Za-z0-9_]+)/g;
  for (const match of source.matchAll(pattern)) map.set(match[1], match[2]);
  return map;
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

test('组装根接上了 ClientUserStore 每一个带缺席判断的端口', async () => {
  const storeSource = stripComments(await readFile(STORE_URL, 'utf8'));
  const rootSource = stripComments(await readFile(ROOT_URL, 'utf8'));
  const fields = guardedFields(storeSource);
  const options = optionByField(storeSource);

  assert.ok(
    fields.length >= 4,
    `只读出 ${fields.length} 个端口 ⇒ 事实源的写法变了、本闸已经在空转`
      + '（而不是「已经没有这类端口了」）',
  );

  const block = clientUserStoreBlock(rootSource);
  for (const field of fields) {
    const option = options.get(field);
    assert.ok(option, `${field} 有缺席判断却不是构造参数赋来的 —— 本闸的字段→参数映射已失真`);
    if (option in DELIBERATELY_UNWIRED) continue;
    assert.match(
      block,
      new RegExp(`(^|[^A-Za-z0-9_])${option}\\s*:`),
      `组装根漏接 ${option}（字段 ${field}）：这个端口写了缺席判断，`
        + '漏掉之后要么被当成成功、要么抛给一个会把它吞掉的调用点，两种都只有真跑才现形',
    );
  }
});

test('三个跨域端口接的是真实现，不是应付闸的空壳', async () => {
  const rootSource = stripComments(await readFile(ROOT_URL, 'utf8'));
  const block = clientUserStoreBlock(rootSource);
  const wirings: ReadonlyArray<[string, RegExp, string]> = [
    [
      'refreshFacebookOperationPolicyAuthority',
      /refreshFacebookOperationPolicyAuthority\s*:[\s\S]*?refreshFromAuthority\s*\(/,
      '这一格 MUST 落到运行策略存储的 refreshFromAuthority()：'
        + '接一个不刷新的实现与漏接同义（客户端照样在建号后读到 503）',
    ],
    [
      'offboardMaterialization',
      /offboardMaterialization\s*:\s*new OffboardMaterializationHttpClient\(/,
      '台账物化 MUST 走属主进程：本进程没有 automation 的库连接，'
        + '任何本地实现都只能写错库或什么都不写',
    ],
    [
      'cleanupGrantOps',
      /cleanupGrantOps\s*:\s*new OffboardCleanupGrantHttpClient\(/,
      '清理授权签发 / 烧票同上：两笔事务碰的表全是 automation 属主，MUST 由属主自开事务',
    ],
  ];
  for (const [name, pattern, why] of wirings) {
    assert.match(block, pattern, `${name}：${why}`);
  }
});
