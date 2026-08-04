/**
 * 启动外壳的形状闸（change deploy-derived-services-to-dev，任务 2.3 / 2.4）。
 *
 * 两条都属于「失效时不出声」的那一类：
 *
 * ① **公共出口不得承载启动副作用**。出口列表是编译期事实，而「被直接执行才启动」那道判断是
 *    运行期的——只要组装根还在出口里，任何一次意外的顶层求值都能把整套装配（建池、注册定时器）
 *    拽进调用方进程，而调用方不会收到任何提示。
 *    断言按**正向**写（出口只许出现在白名单里），不按「找不到某个名字」写：反向写法在新增
 *    文件时默认危险——有人加一行 `export * from './new-root.js'`，反向断言照旧全绿。
 *
 * ② **启动日志必须能区分「未注册」与「已注册且空闲」**。两者在「进程活着、端口通」这个维度上
 *    完全同形，而前者是配置或依赖出了问题、需要有人去修。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatApiCapabilityRoster } from '../../src/server.js';

/** 本仓愿意被别人 import 的能力面。加一行 = 一次显式判断，不该靠改 index.ts 悄悄发生。 */
const ALLOWED_PUBLIC_EXPORTS = new Set([
  './account-store.js',
  './client-auth/index.js',
  './config/index.js',
  './feishu/index.js',
  './interactions/interaction-api-writes.js',
  './panel/index.js',
  './publish-agent/publish-log-store.js',
]);

test('公共出口只列能力面：组装根与可执行入口 MUST NOT 在其中', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const exported = [...source.matchAll(/export\s+\*\s+from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(exported.length > 0, 'index.ts 一条出口都没有，断言本身就该被质疑');
  for (const spec of exported) {
    assert.ok(
      ALLOWED_PUBLIC_EXPORTS.has(spec),
      `index.ts 出口了未经判断的模块：${spec}。`
        + '若它确实是能力面，把它加进本用例的白名单（那是一次显式判断）；'
        + '若它是组装根或入口，import 本包就会顺带把装配拉起来。',
    );
  }
});

test('能力缺席在日志里具名说出，且与「已注册」不同形', () => {
  const text = formatApiCapabilityRoster([
    { name: 'api-owner-authorities', registered: true },
    {
      name: 'content-scheduling',
      registered: false,
      reason: '部署目标非法 ⇒ 调度器未构造',
    },
  ]);
  assert.match(text, /已注册=api-owner-authorities/);
  assert.match(text, /未注册=content-scheduling（部署目标非法 ⇒ 调度器未构造）/);
  // 缺席的那条 MUST NOT 出现在「已注册」那一侧——两侧同源于一个数组，这条断言钉的就是这件事。
  const registeredSide = text.slice(0, text.indexOf('；未注册='));
  assert.ok(!registeredSide.includes('content-scheduling'));
});

test('全部就位时「未注册」明确答「无」，MUST NOT 留空让人自己猜', () => {
  const text = formatApiCapabilityRoster([{ name: 'api-owner-authorities', registered: true }]);
  assert.match(text, /未注册=无/);
});

/**
 * 面板 API 与客户鉴权 API **必须有调用点**。
 *
 * 这条钉的是一次真事故形态：两块的实现随属主搬进了本仓，手写的 main() 却从头到尾没调用它们。
 * 本仓的编译期与测试对此**完全无感**——代码在、没人调，和「调了但对面 404」一样安静；
 * 只有单体停掉那一刻才会发现管理后台整个打不开、桌面客户端登不上。
 */
test('面板与客户鉴权都在组装根里有真调用点', async () => {
  const source = await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
  for (const starter of ['startPanelApi(', 'startClientAuthApi(']) {
    const calls = source.split(starter).length - 1;
    assert.ok(
      calls >= 1,
      `组装根里找不到 ${starter} 的调用点——这两块只要没人调，本仓一切照绿，`
        + '而单体一停 console 与客户端登录同时消失。',
    );
  }
});
