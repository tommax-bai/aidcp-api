/**
 * 内容排期调度器在接口进程里的装配（change wire-content-scheduler-into-api-process）。
 *
 * **本文件钉的是「接线在场 + 落点唯一」，不是调度逻辑**——那由 `content-scheduler.test.ts` 覆盖。
 * 出事的地方一直是装配：类在本仓、按分工也归本仓，而手写入口从不构造它；外部看到的是
 * 「到点什么都没发生」，与「队列里暂时没活」完全同形，且没有一行日志说为什么。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createApiContentSchedulerRuntime,
  type ApiContentSchedulerDeps,
} from '../src/api-content-scheduling.js';
import type { ContentSchedulingAutomationPort } from 'aidcp-kernel/kernel/content-scheduling-port.js';
import type { ContentScheduleView } from '../src/orchestrator/content-scheduler.js';

const UNREACHABLE = (): never => {
  throw new Error('automation_unreachable');
};

function automationStub(
  overrides: Partial<ContentSchedulingAutomationPort> = {},
): ContentSchedulingAutomationPort {
  return {
    listOnlineAccounts: async () => ({ accounts: [] }),
    readRiskStatus: async () => ({ status: 'normal' }),
    readPublishBusy: async () => ({ busy: false }),
    readCommentBusy: async () => ({ busy: false }),
    readJoinBusy: async () => ({ busy: false }),
    readDelegatedOwnershipBusy: async () => ({ busy: false }),
    readCommentedTodayCount: async () => ({ count: 0 }),
    readJoinedTodayCount: async () => ({ count: 0 }),
    readJoinDailyCap: async () => ({ cap: 0 }),
    triggerScheduledPost: async () => ({ accepted: true }),
    triggerScheduledComment: async () => ({ accepted: true }),
    triggerScheduledJoin: async () => ({ accepted: true }),
    ...overrides,
  };
}

const SCHEDULE: ContentScheduleView = {
  autoEnabled: true,
  postEnabled: true,
  postMode: 'review',
  postDailyCap: 2,
  commentEnabled: false,
  commentMode: 'off',
  commentDailyCap: 0,
  contactCommentEnabled: false,
  contactCommentMode: 'off',
  contactCommentDailyCap: 0,
  effectiveMask: '1'.repeat(168),
};

function deps(overrides: Partial<ApiContentSchedulerDeps> = {}): {
  deps: ApiContentSchedulerDeps;
  warns: string[];
  cards: string[];
} {
  const warns: string[] = [];
  const cards: string[] = [];
  return {
    warns,
    cards,
    deps: {
      executionTarget: 'dev',
      automation: automationStub(),
      availablePublishMediaCount: async () => 0,
      schedule: {
        effectiveScheduleFor: () => SCHEDULE,
        effectiveActiveWeekMaskFor: () => null,
        claimAutoPostHourCell: async () => true,
      },
      publishLog: {
        countPublishedTodayForAccount: async () => 0,
        countPendingAutonomousForAccount: async () => 0,
      },
      contactAttempts: {
        countContactAttemptsToday: async () => 0,
        recordContactCommentAttempt: async () => undefined,
      },
      joinAutomationFor: () => ({ enabled: false, dailyCap: 0, weekMask: null }),
      effectiveFacebookOperationMode: async () => 'blocked',
      getPlatform: async () => 'xiaohongshu',
      isWeekActiveAt: () => true,
      deliver: async (input) => {
        cards.push(`${input.command}|${input.title}`);
      },
      logger: { warn: (m) => warns.push(m), info: () => {} },
      ...overrides,
    },
  };
}

test('部署目标合法 → 调度器真的构造出来并能起心跳', () => {
  const built = deps();
  const runtime = createApiContentSchedulerRuntime(built.deps);
  assert.notEqual(runtime.scheduler, null);
  runtime.start(60_000);
  runtime.stop();
});

test('部署目标缺失 → 不构造、留具名 fail-closed 痕迹，且绝不按默认目标降级跑', async () => {
  const built = deps({ executionTarget: null });
  const runtime = createApiContentSchedulerRuntime(built.deps);
  assert.equal(runtime.scheduler, null);
  assert.equal(built.warns.length, 1);
  assert.match(built.warns[0], /部署目标缺失或非法/);
  // 回程在这种进程上 MUST 响亮失败：回 false 读作「调度器看过了、没接管」，
  // 与「这个进程根本没有调度器」同形，而后者是配置问题。
  await assert.rejects(
    () => runtime.reportScheduledTaskNotStarted('acc-1', 'comment', 'edge_offline'),
    /content_scheduler_not_running_in_this_process/,
  );
  // 起停是 no-op，不炸：接口服务其余能力照常。
  runtime.start(60_000);
  runtime.stop();
});

test('依赖暂不可达仍然构造并启动 —— 不可达是运行期事实，不是启动闸', async () => {
  const built = deps({ automation: automationStub({ listOnlineAccounts: UNREACHABLE }) });
  const runtime = createApiContentSchedulerRuntime(built.deps);
  assert.notEqual(runtime.scheduler, null);
  await runtime.scheduler!.onTick();
  assert.match(built.warns.join('\n'), /在线账号清单取用失败/);
});

test('回程与本地路径共用同一个方法 —— 小时格账本只有一本', async () => {
  const built = deps();
  const runtime = createApiContentSchedulerRuntime(built.deps);
  const seen: string[] = [];
  const scheduler = runtime.scheduler!;
  const original = scheduler.reportNotStarted.bind(scheduler);
  scheduler.reportNotStarted = (accountId, action, reason) => {
    seen.push(`${accountId}|${action}|${reason}`);
    return original(accountId, action, reason);
  };
  await runtime.reportScheduledTaskNotStarted('acc-1', 'comment', 'lease_unavailable');
  assert.deepEqual(seen, ['acc-1|comment|lease_unavailable']);
});

test('未受理分两种：瞬时的归还小时格且不回卡，持久的回一张卡', async () => {
  const transient = deps({
    automation: automationStub({
      triggerScheduledComment: async () => ({
        accepted: false,
        reason: 'edge_offline',
        retryable: true,
      }),
    }),
  });
  const transientRuntime = createApiContentSchedulerRuntime(transient.deps);
  assert.deepEqual(
    await transientRuntime.schedulerDeps!.triggerComment!('acc-1', 'review'),
    { started: false, reason: 'edge_offline' },
    '瞬时未开始 MUST 归还小时格，本小时内还能再试',
  );
  assert.deepEqual(transient.cards, [], '重试期每次都发卡就是每分钟刷一张告警');

  const permanent = deps({
    automation: automationStub({
      triggerScheduledComment: async () => ({
        accepted: false,
        reason: 'needs_persona_setup',
        level: 'warning',
        title: '排期评论：未绑定人设',
        message: '该账号未绑定人设，本次不发。',
      }),
    }),
  });
  const permanentRuntime = createApiContentSchedulerRuntime(permanent.deps);
  assert.equal(
    await permanentRuntime.schedulerDeps!.triggerComment!('acc-1', 'review'),
    undefined,
    '持久性未触发 MUST 烧掉本格 —— 重试无用',
  );
  assert.deepEqual(permanent.cards, ['排期评论（自动）|排期评论：未绑定人设']);
});

test('已受理 MUST NOT 再回一张终态卡 —— 结局在自动化侧，两侧都发运营就分不出是哪条路径', async () => {
  const built = deps();
  const runtime = createApiContentSchedulerRuntime(built.deps);
  assert.equal(
    await runtime.schedulerDeps!.triggerPost('acc-1', 'review', {
      executionTarget: 'dev',
      envKey: null,
      hourCell: '2026-08-03-10',
    }),
    undefined,
  );
  assert.deepEqual(built.cards, []);
});

test('接口进程的手写入口 MUST 构造并启动它 —— 复发断言', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  // 钉调用表达式而不是 import 说明符：import 留着、构造删掉正是本次要修的那个形态。
  assert.match(source, /createApiContentSchedulerRuntime\(\{/);
  assert.match(source, /root\.contentScheduler\.start\(\)/);
  assert.match(source, /registerScheduleFeedbackRoutes\(/);
});
