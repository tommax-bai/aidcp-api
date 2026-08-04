/**
 * 接口进程的可执行入口。**systemd 的 `ExecStart` 指这里**，不指 `server.ts`。
 *
 * ## 顺序是外壳的全部内容，且不可换
 *
 * 读配置 → **schema 契约门** → 建组装根 → **先监听** → 就绪闸 → 放行业务 → 优雅关停 → 信号。
 * 三个服务（api / automation / content）同形，理由不是整齐：不同形的直接后果是「某个服务在
 * 就绪之前就开始干活」，而那件事在这套系统里意味着一个还没放行的进程去认领带租约的任务。
 *
 * - **门在建池之前**：门跑在建池之后等于先连上一个落后的库，再由某个存储在某次调用上炸掉。
 *   门本身 MUST NOT 被 try/catch 吞（enforce 模式下它自己抛，异常冒到这里 ⇒ 非 0 退出 ⇒
 *   systemd 重启，这是设计）。
 * - **先监听后就绪**：倒过来的话，健康检查在就绪之前拿不到任何应答，
 *   「还在初始化」与「进程死了」从外面同形。
 *
 * ## 失败时**真的退出**
 *
 * 旧形态只设 `process.exitCode` 而不 `exit`：组装根已经建了池、注册了定时器，事件循环上还挂着
 * 引用，进程于是留在那里不动——systemd 看到 `active (running)`，既不服务也不重启。
 * 本入口在失败路径上先尽力关停已建起来的东西，再显式 `process.exit(1)`。
 */
import { pathToFileURL } from 'node:url';

import { runApiStartupSchemaGate } from './api-schema-gate-startup.js';
import { startApiService } from './server.js';

export interface ApiEntryOptions {
  /** 信号挂在哪。传 `null` 表示不挂（测试与嵌入式调用用）。缺省是 `process`。 */
  signals?: {
    on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
    off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
  } | null;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 进程退出。抽出来只为测试可观测；生产上就是 `process.exit`。 */
  exit?: (code: number) => never;
}

export async function runApiEntry(options: ApiEntryOptions = {}): Promise<void> {
  const logger = options.logger ?? console;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signalSource = options.signals === null ? null : (options.signals ?? process);

  // ① 门：main() 的第一句，建池之前，**不包 try/catch**。
  const schemaGate = await runApiStartupSchemaGate();

  // ② 建根 + 先监听 + 就绪闸 + 放行业务（都在 startApiService 里，顺序已钉死）。
  let service: Awaited<ReturnType<typeof startApiService>>;
  try {
    service = await startApiService({ schemaGate });
  } catch (error) {
    logger.error('[aidcp-api] 启动失败：', error);
    return exit(1);
  }

  // ③ 优雅关停 + 信号。收到信号先摘掉自己 ⇒ **第二个信号落回 Node 默认处置（立刻结束）**：
  // 关停若卡住，运维不该被迫去找 kill -9，而本入口也不该自己发明一个超时上限。
  let closing = false;
  const onSignal = (): void => {
    if (closing) return;
    closing = true;
    if (signalSource) {
      signalSource.off('SIGTERM', onSignal);
      signalSource.off('SIGINT', onSignal);
    }
    logger.log('[aidcp-api] 收到终止信号，开始优雅关停');
    void service
      .close()
      .then(() => {
        logger.log('[aidcp-api] 已关停');
        // **关停干净就必须以 0 退出。**
        // 摘掉信号处理器之后，同一次信号会落回 Node 的默认处置 ⇒ 进程以 143（128+SIGTERM）结束，
        // 而 systemd 把非 0 一律记成 `failed`。dev 上实测过：一次完全正常的停机在
        // `systemctl status` 里显示 failed —— 「干净停下」与「崩了」从进程管理器那一侧完全同形，
        // 而那正是运维唯一会看的那一眼。
        exit(0);
      })
      .catch((error: unknown) => {
        logger.error('[aidcp-api] 优雅关停失败：', error);
        exit(1);
      });
  };
  if (signalSource) {
    signalSource.on('SIGTERM', onSignal);
    signalSource.on('SIGINT', onSignal);
  }
}

/** 直接执行本文件时才启动（被 import 时不启动）。形态与自动化进程那份逐字一致。 */
export function isDirectExecution(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  return Boolean(argv1) && pathToFileURL(argv1).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  void runApiEntry();
}
