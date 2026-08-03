/**
 * 内容排期调度器在**接口进程**里的装配（change wire-content-scheduler-into-api-process）。
 *
 * 拆成三个进程之后，这个每分钟醒一次的触发器一度**没有任何进程在跑**：它按分工归接口服务、
 * 类也在本仓，但接口服务的手写入口从不构造它。今天不出事只因为还是单体在跑。真拆开那天，
 * 到点什么都不会发生，**且没有一行日志说为什么**——「队列里暂时没活」与「永远没人来处理」
 * 在外部完全同形。本文件就是那个缺失的构造点。
 *
 * ── 三件事在这里被决定，改之前先读 ────────────────────────────────────────────
 *
 * **一、跨进程取用一律不兜缺省值。** 客户端失败靠抛；判「哪边更严」的是调度器自己
 *（在线清单问不到 → 整轮跳过；风控问不到 → 跳过该账号；三个「在不在跑」问不到 → 判为在跑）。
 * 本文件的适配闭包**只做形状转换，不加 catch**——加一个 catch 就把那个决定从调度器手里拿走了。
 *
 * **二、扳机的回执是「受不受理」。** 已受理 ⇒ 终态卡由自动化侧发（结局在它那儿），本侧不发；
 * 未受理 ⇒ 按 `retryable` 分流：瞬时的归还小时格、本小时内有界重试且**不回卡**（重试期每次
 * 都发卡就是每分钟刷一张告警），持久的烧掉本格并如实回一张卡。
 *
 * **三、部署目标是启动前提，不是运行期开关。** 本进程的组装根在更早一步就要求它必须是 dev 或 ol
 *（`deploymentTarget()` 解析失败即整个进程起不来），所以到这里它恒合法。{@link createApiContentSchedulerRuntime}
 * 仍显式接受 `null` 并在那种情况下**不构造调度器、留一行具名 fail-closed 日志**：这条分支在生产
 * 路径上到不了，但它是可以喂违规输入验证的——一个只能靠「相信它还在」的闸等于没有闸。
 */
import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import type {
  ContentSchedulingAutomationPort,
  ScheduledTriggerAcceptance,
} from 'aidcp-kernel/kernel/content-scheduling-port.js';
import {
  ContentScheduler,
  scheduledContactCommentLabel,
  type ContentScheduleView,
  type ContentSchedulerDeps,
  type OnlineAccountIdentity,
  type ScheduleTriggerOutcome,
  type ScheduledPostExecution,
} from './orchestrator/content-scheduler.js';

/** 触发未受理时回给运营的那张卡；成功 / 空槽 / 失败的终态卡由自动化侧发。 */
type NotificationDeliver = (input: {
  command: string;
  ok: boolean;
  level: 'success' | 'warning' | 'error';
  title: string;
  message: string;
  accountId: string;
}) => Promise<void>;

export interface ApiContentSchedulerDeps {
  /** 本机部署事实。`null` = 解析不出 ⇒ 不启动调度器（MUST NOT 按默认目标降级跑）。 */
  executionTarget: DeploymentTarget | null;
  /** 自动化服务那一族窄口。 */
  automation: ContentSchedulingAutomationPort;
  /** 素材可用数（属主在内容服务）。问不到由调度器按 0 处置并具名留痕。 */
  availablePublishMediaCount(accountId: string): Promise<number>;
  schedule: {
    effectiveScheduleFor(accountId: string): ContentScheduleView;
    effectiveActiveWeekMaskFor(accountId: string): string | null;
    claimAutoPostHourCell(input: {
      accountId: string;
      hourCell: string;
      executionTarget: DeploymentTarget;
      envKey: string | null;
    }): Promise<boolean>;
  };
  publishLog: {
    countPublishedTodayForAccount(accountId: string): Promise<number>;
    countPendingAutonomousForAccount(accountId: string): Promise<number>;
  };
  contactAttempts: {
    countContactAttemptsToday(accountId: string): Promise<number>;
    recordContactCommentAttempt(accountId: string): Promise<unknown>;
  };
  joinAutomationFor(accountId: string): {
    enabled: boolean;
    dailyCap: number;
    weekMask: string | null;
  };
  effectiveFacebookOperationMode(
    accountId: string,
  ): Promise<'persona' | 'slow_start' | 'rule' | 'consumption' | 'blocked'>;
  getPlatform(accountId: string): Promise<PlatformId>;
  isWeekActiveAt(mask: string | null, now: Date): boolean;
  deliver: NotificationDeliver;
  logger: { warn(message: string): void; info?(message: string): void };
}

export interface ApiContentSchedulerRuntime {
  /** `null` = 没构造（部署目标缺失或非法）。 */
  scheduler: ContentScheduler | null;
  /**
   * 喂给调度器的那份依赖实现。**导出它只为可测**：本文件的核心判断是三条扳机的
   *「受不受理 → 小时格怎么处置」那层翻译，而它在生产路径上藏在调度器内部；不把这份依赖
   * 拿出来喂输入，那层翻译就只能靠「相信它是对的」。`null` 时同样是 `null`。
   */
  schedulerDeps: ContentSchedulerDeps | null;
  /**
   * 「本槽未能开始、归还小时格」的落点。**与调度器本地路径调用的是同一个方法**——
   * 小时格账本只有调度器自己那一本，第二条写入路径就是第二本账。
   *
   * 没有调度器时**响亮抛具名错误**，MUST NOT 回 false：false 读作「调度器看过了、没接管」，
   * 与「这个进程根本没有调度器」完全同形，而后者是配置问题、必须有人去修。
   */
  reportScheduledTaskNotStarted(
    accountId: string,
    action: 'comment' | 'contact_comment',
    reason: string,
  ): Promise<boolean>;
  start(intervalMs?: number): void;
  stop(): void;
}

/** 把「受不受理」翻译成调度器认得的小时格语义。**只做翻译，不吞异常。** */
function acceptanceToOutcome(
  acceptance: ScheduledTriggerAcceptance,
  command: string,
  accountId: string,
  deliver: NotificationDeliver,
  logger: ApiContentSchedulerDeps['logger'],
): ScheduleTriggerOutcome | undefined {
  // 已受理：管线接手了，终态卡由自动化侧发。本侧再发一张就是同一结局两张卡，
  // 运营会分不出是哪条路径放行的。
  if (acceptance.accepted) return undefined;
  // 瞬时未开始：归还小时格、本小时内有界重试。**刻意不回卡**——重试期每次都发卡就是噪声；
  // 重试用尽时由调度器的整格放弃回调统一发一张。
  if (acceptance.retryable) {
    return { started: false, reason: acceptance.reason ?? 'not_started' };
  }
  // 持久性未触发：重试无用，照旧烧掉本格并如实回一张卡。
  void deliver({
    command,
    ok: false,
    level: acceptance.level ?? 'warning',
    title: acceptance.title ?? `${command}：本槽未触发`,
    message: acceptance.message ?? acceptance.reason ?? 'unknown',
    accountId,
  }).catch((err: unknown) =>
    logger.warn(`[api-content-scheduling] ${command}回执卡发送失败：${(err as Error).message}`),
  );
  return undefined;
}

export function createApiContentSchedulerRuntime(
  deps: ApiContentSchedulerDeps,
): ApiContentSchedulerRuntime {
  const { executionTarget } = deps;
  if (!executionTarget) {
    // fail-closed 且具名。**MUST NOT 按默认目标降级跑**：DEV/OL 长期共用一个数据库，
    // 猜一个目标就是往另一台机器的账号上发内容。
    deps.logger.warn(
      '[api-content-scheduling] 内容排期调度器未启动：本机部署目标缺失或非法（须为 dev 或 ol）。'
        + '接口服务其余能力照常，但本进程不会到点触发任何排期动作。',
    );
    return {
      scheduler: null,
      schedulerDeps: null,
      reportScheduledTaskNotStarted: async () => {
        throw new Error('content_scheduler_not_running_in_this_process');
      },
      start: () => {},
      stop: () => {},
    };
  }

  const triggerComment = async (
    accountId: string,
    approvalMode: ContentScheduleView['commentMode'] & ('review' | 'auto_approve'),
    variant: 'comment' | 'contact_comment',
  ): Promise<ScheduleTriggerOutcome | undefined> => {
    const label =
      variant === 'contact_comment'
        ? scheduledContactCommentLabel(await deps.getPlatform(accountId))
        : '评论';
    const command = `排期${label}（自动）`;
    const acceptance = await deps.automation.triggerScheduledComment({
      accountId,
      approvalMode,
      variant,
    });
    const outcome = acceptanceToOutcome(acceptance, command, accountId, deps.deliver, deps.logger);
    // 联系评论的**尝试型**日上限：只有真开跑才占额度（被拒 / 无目标不占）。
    // 台账属主在本域，故记账留在这一侧。
    if (variant === 'contact_comment' && acceptance.accepted) {
      await deps.contactAttempts.recordContactCommentAttempt(accountId);
    }
    return outcome;
  };

  const schedulerDeps: ContentSchedulerDeps = {
    executionTarget,
    // ── 跨进程：一律不加 catch。失败方向由调度器按「哪边更严」判 ────────────────
    onlineAccounts: async (): Promise<readonly OnlineAccountIdentity[]> =>
      (await deps.automation.listOnlineAccounts()).accounts.map((account) => ({
        accountId: account.accountId,
        envKey: account.envKey,
      })),
    riskStatus: async (accountId) =>
      (await deps.automation.readRiskStatus({ accountId })).status,
    isPublishBusy: async (accountId) =>
      (await deps.automation.readPublishBusy({ accountId })).busy,
    isCommentBusy: async (accountId) =>
      (await deps.automation.readCommentBusy({ accountId })).busy,
    isJoinBusy: async (accountId) => (await deps.automation.readJoinBusy({ accountId })).busy,
    delegatedOwnershipBusy: async (accountId, family) =>
      (await deps.automation.readDelegatedOwnershipBusy({ accountId, family })).busy,
    commentedTodayCount: async (accountId) =>
      (await deps.automation.readCommentedTodayCount({ accountId })).count,
    joinedTodayCount: async (accountId) =>
      (await deps.automation.readJoinedTodayCount({ accountId })).count,
    joinDailyCap: async (accountId) =>
      (await deps.automation.readJoinDailyCap({ accountId })).cap,

    // ── 本域现成的：进程内直读，不走跨进程 ──────────────────────────────────
    scheduleFor: (accountId) => deps.schedule.effectiveScheduleFor(accountId),
    claimPostHourCell: (identity, hourCell) =>
      deps.schedule.claimAutoPostHourCell({
        accountId: identity.accountId,
        envKey: identity.envKey,
        executionTarget,
        hourCell,
      }),
    postedTodayCount: (accountId) => deps.publishLog.countPublishedTodayForAccount(accountId),
    pendingAutonomousCount: (accountId) =>
      deps.publishLog.countPendingAutonomousForAccount(accountId),
    contactAttemptsTodayCount: (accountId) =>
      deps.contactAttempts.countContactAttemptsToday(accountId),
    joinAutomationFor: (accountId) => deps.joinAutomationFor(accountId),
    effectiveFacebookOperationMode: (accountId) =>
      deps.effectiveFacebookOperationMode(accountId),
    getPlatform: (accountId) => deps.getPlatform(accountId),
    // 自动 ⊆ 活跃：读浏览周历掩码，沿其 fail-open（未配 = 全天活跃 = 不额外限制）。
    browseActiveAt: (accountId, now) =>
      deps.isWeekActiveAt(deps.schedule.effectiveActiveWeekMaskFor(accountId), now),
    availablePublishMediaCount: (accountId) => deps.availablePublishMediaCount(accountId),

    // ── 三类扳机 ───────────────────────────────────────────────────────────
    triggerPost: async (accountId, approvalMode, execution: ScheduledPostExecution) =>
      acceptanceToOutcome(
        await deps.automation.triggerScheduledPost({ accountId, approvalMode, execution }),
        '排期发帖（自动）',
        accountId,
        deps.deliver,
        deps.logger,
      ),
    triggerComment: (accountId, approvalMode) =>
      triggerComment(accountId, approvalMode, 'comment'),
    triggerContactComment: (accountId, approvalMode) =>
      triggerComment(accountId, approvalMode, 'contact_comment'),
    triggerJoin: async (accountId) =>
      acceptanceToOutcome(
        await deps.automation.triggerScheduledJoin({ accountId }),
        '排期加群（自动）',
        accountId,
        deps.deliver,
        deps.logger,
      ),

    /** 本小时格的有界重试用尽 → 发**一张**放弃卡（重试期间刻意不发）。 */
    onCellAbandoned: (accountId, action, reason) => {
      void (async () => {
        const label =
          action === 'comment'
            ? '评论'
            : action === 'contact_comment'
              ? scheduledContactCommentLabel(await deps.getPlatform(accountId))
              : action === 'join'
                ? '加群'
                : '发帖';
        await deps.deliver({
          command: `排期${label}（自动）`,
          ok: false,
          level: 'warning',
          title: '本小时未能开始，已放弃',
          message: `多次尝试后仍未接管边端（原因：${reason}）。本小时未搜索、未选中、未发布；下一个小时格会重新尝试。`,
          accountId,
        });
      })().catch((err: unknown) =>
        deps.logger.warn(
          `[api-content-scheduling] 放弃卡发送失败：${(err as Error).message}`,
        ),
      );
    },
    logger: deps.logger,
  };

  const scheduler = new ContentScheduler(schedulerDeps);
  return {
    scheduler,
    schedulerDeps,
    reportScheduledTaskNotStarted: async (accountId, action, reason) =>
      scheduler.reportNotStarted(accountId, action, reason),
    start: (intervalMs = 60_000) => scheduler.start(intervalMs),
    stop: () => scheduler.stop(),
  };
}
