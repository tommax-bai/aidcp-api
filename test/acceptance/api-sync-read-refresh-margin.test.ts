/**
 * AC-API-SR-MARGIN-01 周期刷新 MUST 明显短于新鲜期 —— 新鲜度不许靠变更通知维持。
 *
 * **判据是「假设这条流的变更通知全部消失，它还能不能长期保持 fresh」。**
 * 答案为否，就说明新鲜度实际上挂在通知通道上；而通知按设计只是加速器，
 * 承重的是周期完整快照（`performRefresh` 的注释也这么写着）。
 *
 * 这条不是调参。本 change 之前，周期刷新的默认值恰好**等于**属主给的新鲜期窗口，
 * dev 上同时长出两种表现，同一个根因：
 *
 *   · `session_config_global` 没有变更通知托底 ⇒ 每分钟一条
 *     「全局周活跃掩码镜像非 fresh（state=stale），本次按『未配置』处理」，
 *     客户端因此显示全天活跃；
 *   · `automation_config_mirror_health` 反而不抖 —— 因为它的载荷里带了个时钟、
 *     每 10 秒发一次通知，顺手把新鲜期续上了。**那个 churn 本身是 bug**
 *     （它把 event_outbox 撑到 14 万行 / 45MB）；修掉它而不改这个周期，
 *     等于把这条流也推进同一种抖动 —— 用一处数据库膨胀换一处就绪度抖动。
 *
 * 属主侧的重发周期另有一条同比例的闸（automation 仓 `AC-SR-MARGIN-01`）。
 * 两条都要有：一条守「属主多久重发一次」，一条守「消费方多久取一次」，
 * 任一条松掉都会重新打开那段空窗。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  API_SYNC_READ_FULL_REFRESH_MS,
  API_SYNC_READ_REFRESH_MS,
} from '../../src/server.js';

test('AC-API-SR-MARGIN-01 周期刷新 ≤ 新鲜期窗口的三分之一', () => {
  assert.ok(
    API_SYNC_READ_REFRESH_MS * 3 <= API_SYNC_READ_FULL_REFRESH_MS,
    `周期刷新 ${API_SYNC_READ_REFRESH_MS}ms 相对新鲜期窗口 `
      + `${API_SYNC_READ_FULL_REFRESH_MS}ms 余量不够：`
      + '每个周期末尾都会留一段「刚过期、还没重新取到」的空窗，'
      + '没有变更通知托底的流会因此周期性 stale。',
  );
});

test('AC-API-SR-MARGIN-02 上限常量仍是上限，且周期不得退回上限本身', () => {
  // 这两个常量分工不同，撞在一起正是本 change 之前的形态：
  // 上限（= 属主的新鲜期窗口）曾同时被当成默认周期用。
  assert.notEqual(
    API_SYNC_READ_REFRESH_MS,
    API_SYNC_READ_FULL_REFRESH_MS,
    '周期等于新鲜期窗口 ⇒ 余量为零，这正是被修掉的那个默认值',
  );
  assert.ok(API_SYNC_READ_REFRESH_MS > 0);
  assert.ok(Number.isInteger(API_SYNC_READ_REFRESH_MS));
});
