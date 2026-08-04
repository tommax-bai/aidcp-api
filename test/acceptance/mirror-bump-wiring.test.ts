// aidcp:test-owner=derived
// 它读的是**本仓手写的组装根**（`src/server.ts`），在 aidcp-cloud 里没有对应物；
// 没有这行标记，跨仓同步会把它当成「多出的文件」，`--prune` 一跑就没了。
/**
 * 「属主存储写了表，却没推配置镜像版本」的接线闸。
 *
 * ## 它防的是什么
 *
 * `writeWithMirrorBump(pool, bumper, key, run)` 的第一行是
 * `if (!bumper) return run(pool)` —— **推进器缺席时，写照常提交、版本一动不动、
 * 不报错也不告警**。这正是拆仓红线里那条「裸 `?.` 静默吞掉」的形态：单体里那一格恒有，
 * 派生仓自己写 main() 时漏掉不会有任何东西说出来。
 *
 * 后果有两层，第二层 2026-08-04 真把 dev 拖到起不来：
 *   ① 消费方镜像永远不刷新 —— 新账号 / 新人设对自动化进程从此不存在（**零信号**）；
 *   ② 同一个游标上先后发出两种载荷摘要 ⇒ 消费方按设计**永久**拒收 ⇒
 *      自动化一重启就 `same_cursor_payload_drift`、业务入口不放行、8787 消失。
 *      当天实测：12 条人设写进了库，`persona_config` 的版本号一次没动。
 *
 * ## 为什么不能只钉「我知道的那几个」
 *
 * 覆盖面 MUST 从**事实源**读出来：凡是「选项里有 `mirrorVersionBumper`」的存储类，
 * 都是在说「我有会改镜像载荷的写口」。手抄一张名单的话，下一个新增的存储不在名单里，
 * 闸对它全绿 —— 这正是「守卫只覆盖作者当时在治的那条道」那类事故。
 * 本闸因此先扫 `src/` 得出这张类名表，再回到组装根逐个核。
 *
 * ## 例外怎么写
 *
 * {@link DELIBERATELY_UNBUMPED}：逐条写清**为什么这个存储在本进程不需要推版本**。
 * 「本进程今天只读它」**不是**合格理由 —— 读写归属会变，而变的那天没有任何东西会提醒人，
 * 且接上它在没有写发生时代价为零。合格的理由只有「这张表根本不是任何同步读流的载荷来源」
 * 之类的结构性事实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');
const ASSEMBLY_FILE = join(SRC, 'server.ts');

/** 本进程刻意不接推进器的存储，逐条写清结构性理由。今天是空的。 */
const DELIBERATELY_UNBUMPED: Readonly<Record<string, string>> = {};

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * 事实源：凡是**选项接口里声明了 `mirrorVersionBumper`** 的文件，
 * 取它导出的第一个 class 名 —— 那就是「有会改镜像载荷的写口」的存储类。
 */
async function bumpAwareStoreClasses(): Promise<string[]> {
  const names: string[] = [];
  for (const file of await tsFiles(SRC)) {
    if (file === ASSEMBLY_FILE) continue;
    const source = await readFile(file, 'utf8');
    // 声明点长这样：`mirrorVersionBumper?: MirrorVersionBumper;`（选项接口里）。
    // 只有实现方 `mirror-version-store.ts` 例外：它导出的是类型本身，不是消费方。
    if (!/mirrorVersionBumper\??\s*:\s*MirrorVersionBumper/.test(source)) continue;
    const cls = /export class ([A-Za-z0-9_]+)/.exec(source)?.[1];
    if (cls) names.push(cls);
  }
  return [...new Set(names)].sort();
}

/** 抠出组装根里 `new <Class>({ … })` 那段对象字面量（括号配平，不靠行数）。 */
function constructionLiteral(source: string, cls: string): string | null {
  const start = source.indexOf(`new ${cls}({`);
  if (start === -1) return null;
  let i = source.indexOf('{', start);
  let depth = 0;
  const from = i;
  for (; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return null;
}

test('AC-MIRROR-01 事实源不为空（表空了说明扫描方式坏了，而不是「没有需要接的」）', async () => {
  const classes = await bumpAwareStoreClasses();
  assert.ok(
    classes.length >= 10,
    `扫到的「会推镜像版本」的存储类只有 ${classes.length} 个 —— 正则大概率失效了。`
      + '本闸一旦扫不到东西就会全绿，那比没有闸更糟。',
  );
});

test('AC-MIRROR-02 组装根里构造的每个此类存储，MUST 真的拿到推进器', async () => {
  const source = await readFile(ASSEMBLY_FILE, 'utf8');
  const missing: string[] = [];
  for (const cls of await bumpAwareStoreClasses()) {
    const literal = constructionLiteral(source, cls);
    if (literal === null) continue; // 本进程不构造它 —— 那不是漏接
    if (Object.prototype.hasOwnProperty.call(DELIBERATELY_UNBUMPED, cls)) continue;
    if (!/\bmirrorVersionBumper\s*:/.test(literal)) missing.push(cls);
  }
  assert.deepEqual(
    missing,
    [],
    '这些存储在本进程被构造、却没拿到镜像版本推进器。它们的写会照常提交、版本一动不动、'
      + '零告警；下一次自动化重启就会撞上 same_cursor_payload_drift：\n'
      + missing.map((c) => `  · ${c}`).join('\n'),
  );
});

test('AC-MIRROR-03 例外表里的名字 MUST 真的是本进程构造的此类存储（防这张表烂掉）', async () => {
  const source = await readFile(ASSEMBLY_FILE, 'utf8');
  const known = new Set(await bumpAwareStoreClasses());
  const stale = Object.keys(DELIBERATELY_UNBUMPED).filter(
    (cls) => !known.has(cls) || constructionLiteral(source, cls) === null,
  );
  assert.deepEqual(
    stale,
    [],
    `这些例外声明已经指向不存在的东西（改名 / 删了 / 本进程压根不构造它）：\n`
      + stale.map((c) => `  · ${c}`).join('\n'),
  );
});
