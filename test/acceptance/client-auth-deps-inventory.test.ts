/**
 * 客户鉴权依赖的清单闸（照同目录 `served-route-inventory.test.ts` 的形态）。
 *
 * **它防的是一类 2026-08-04 一天之内发生了四次的静默事故**：派生服务的组装根是手写的、
 * 从不自动同步，它装配的依赖会悄悄少于单体。而 `ClientAuthDeps` 里几乎每个字段都是
 * **可选**的 —— 于是漏装一个字段：
 *   - 编译得过（可选字段不填本来就合法）；
 *   - 本仓测试全绿（没有任何用例断言「这个字段必须有」）；
 *   - 启动日志一个字不说（没有人在启动期检查依赖完整性）；
 *   - 只有**用户点到那个功能**时才现形，且现形方式是一句 503。
 *
 * 实测：切流当天客户端报 `slow_start_unavailable` / `slow_start_projection_unavailable` /
 * 「今日进展，暂时无法获取」三条，追下去是同一个根因 —— 本仓 23 个字段只装了 9 个。
 * 其中 5 个是切流前就知道并接受的，另外 9 个不在任何清单里，**没有任何机制会说出来**。
 *
 * ## 参照物为什么用类型、不用单体的组装根
 * `ClientAuthDeps` 这个接口定义在 `src/client-auth/client-auth-server.ts`，属 api 层、
 * 是从单体**同步过来的派生物** ⇒ 它永远跟得上真实契约。而单体的 `server.ts` 是手写组装根、
 * 不同步进本仓，拿它当参照等于拿一份可能已经过期的抄件当事实源。
 *
 * ## 三个方向都要锁
 * ① 接口里的每个字段 MUST 要么真的装配了、要么在 {@link DELIBERATELY_ABSENT} 里具名声明缺席；
 * ② 声明缺席的每个名字 MUST 真的是接口字段 —— 否则这张表会随着接口改名悄悄烂掉，
 *    而烂掉的形态是「它还在，只是不再指向任何东西」，比没有这张表更糟；
 * ③ 一个名字 MUST NOT 既装配又声明缺席 —— 那说明缺席声明没跟上接线，
 *    下一个人会据此以为某个已经能用的能力还不能用。
 *
 * **加一个依赖 = 装配它**。**决定不装 = 在下表加一行并写清为什么**，
 * 那是个需要 review 的判断，不该靠少写一行 main() 就悄悄发生。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_FILE = join(HERE, '..', '..', 'src', 'client-auth', 'client-auth-server.ts');
const ASSEMBLY_FILE = join(HERE, '..', '..', 'src', 'server.ts');

/**
 * 本进程**刻意不装**的依赖，逐条写清原因。
 *
 * 原因分三类，别混：
 *   - `NEW_CHANNEL`  —— 数据属 automation / content，`aidcp-transport` 里没有现成通道，
 *                       要新开一条内部 HTTP 路由才能接。
 *   - `KERNEL`       —— 差的是纯函数/纯映射，要先提进 `aidcp-kernel` 才能在本仓用，
 *                       **MUST NOT 在本仓抄第二份**（同一映射两处实现，漂开时不报错，
 *                       只是某一侧把一个还在爬坡的账号按满档跑）。
 *   - `NOT_APPLICABLE` —— 这个能力在派生形态下确实不该由本进程提供。
 *
 * ⚠ **在这张表里 ≠ 用户看到的是好的**：每一条对应客户端上一个答 503 的功能。
 * 这张表的作用是让「答 503」成为一个**有人签过字的决定**，而不是一次没人知道的遗漏。
 */
const DELIBERATELY_ABSENT: Readonly<Record<string, string>> = {
  draftRefinements:
    'NEW_CHANNEL：草稿精修属 content 域，transport 里无现成通道。切流前已知（handoff §3.1 第 3 点）。',
};

/** 抠出 `export interface ClientAuthDeps { … }` 的**顶层**字段名。 */
function contractFields(source: string): string[] {
  const start = source.indexOf('export interface ClientAuthDeps {');
  assert.notEqual(start, -1, '找不到 ClientAuthDeps 接口 —— 参照物没了，本闸失去意义');
  let i = source.indexOf('{', start) + 1;
  let depth = 1;
  const body: string[] = [];
  let line = '';
  while (depth > 0 && i < source.length) {
    const ch = source[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 0) break;
    if (ch === '\n') { body.push(line); line = ''; } else { line += ch; }
    i += 1;
  }
  body.push(line);
  const names: string[] = [];
  let nested = 0;
  for (const raw of body) {
    const text = raw.trim();
    // 只在**顶层**（未进入嵌套对象类型）取名，否则会把内层方法名当成字段。
    if (nested === 0) {
      const m = /^(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(text);
      if (m) names.push(m[1]!);
    }
    nested += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
  }
  return names;
}

/** 抠出组装根里 `const clientAuthDeps: ClientAuthDeps = { … }` 的**顶层**键名。 */
function assembledKeys(source: string): string[] {
  const start = source.indexOf('const clientAuthDeps: ClientAuthDeps = {');
  assert.notEqual(start, -1, '找不到 clientAuthDeps 装配点 —— 改了名就在这里改，别删本闸');
  let i = source.indexOf('{', start) + 1;
  let depth = 1;
  const body: string[] = [];
  let line = '';
  while (depth > 0 && i < source.length) {
    const ch = source[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 0) break;
    if (ch === '\n') { body.push(line); line = ''; } else { line += ch; }
    i += 1;
  }
  body.push(line);
  const names: string[] = [];
  let nested = 0;
  for (const raw of body) {
    const text = raw.trim();
    if (nested === 0) {
      // `foo,`（简写）与 `foo: …` 两种形态都要认。
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:,]/.exec(text);
      if (m) names.push(m[1]!);
    }
    nested += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
  }
  return names;
}

test('AC-CADEPS-01 契约里的每个依赖，要么装配了，要么具名声明缺席', async () => {
  const fields = contractFields(await readFile(CONTRACT_FILE, 'utf8'));
  const wired = new Set(assembledKeys(await readFile(ASSEMBLY_FILE, 'utf8')));
  const unexplained = fields.filter(
    (f) => !wired.has(f) && !Object.prototype.hasOwnProperty.call(DELIBERATELY_ABSENT, f),
  );
  assert.deepEqual(
    unexplained,
    [],
    `这些依赖既没装配、也没声明缺席 —— 用户会在客户端上撞见一句 503，而这边没有任何记录：\n`
      + unexplained.map((f) => `  · ${f}`).join('\n'),
  );
});

test('AC-CADEPS-02 声明缺席的每个名字，MUST 真的是契约字段（防这张表烂掉）', async () => {
  const fields = new Set(contractFields(await readFile(CONTRACT_FILE, 'utf8')));
  const stale = Object.keys(DELIBERATELY_ABSENT).filter((name) => !fields.has(name));
  assert.deepEqual(
    stale,
    [],
    `这些名字已经不是 ClientAuthDeps 的字段了（改名或删除），缺席声明成了空指向：\n`
      + stale.map((f) => `  · ${f}`).join('\n'),
  );
});

test('AC-CADEPS-03 一个依赖 MUST NOT 既装配又声明缺席', async () => {
  const wired = new Set(assembledKeys(await readFile(ASSEMBLY_FILE, 'utf8')));
  const both = Object.keys(DELIBERATELY_ABSENT).filter((name) => wired.has(name));
  assert.deepEqual(
    both,
    [],
    `这些依赖已经接线了，但缺席表里还留着 —— 下一个人会据此以为它还不能用：\n`
      + both.map((f) => `  · ${f}`).join('\n'),
  );
});
