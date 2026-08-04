/**
 * 接口进程的启动期 schema 契约门。
 *
 * ## 这个文件存在的理由：本仓此前一道门都没有
 *
 * 内容进程把门放在 `main()` 第一句、建池之前；自动化进程更进一步，把「门跑过了」做成一张
 * 不可伪造的回执、由启动外壳必填持有。**接口进程两样都没有**：它只有逐存储的
 * `schemaEnsurer`，而那是在**建完池之后**才逐个跑的——落后的 schema 会先被打开连接、
 * 再由某一个存储在某一次调用上炸掉，而不是在启动那一刻被挡住。
 *
 * 「没有门」这件事在行为上什么都不表现：进程照起、日志照打、测试照绿，
 * 只有 schema 真落后的那一次才爆，且那时门本就不在场。
 *
 * ## 只判 api 一个属主
 *
 * 判据是「**本进程真正打开了哪些属主库连接**」，不是「跑的是哪个服务模式」。
 * 本仓全仓只有一处建池（组装根的 `resolveOwnerPgConfig('api')`）⇒ 集合恒等于 `['api']`。
 * 传入集合之外的属主**不读账本、不判定、不出现在结论里**：本进程既然不连 automation /
 * content 的库，就没有立场声称它们的 schema 对或不对——那种「校验通过但其实什么都没校验到」
 * 的假绿，正是这道门存在的意义的反面。
 *
 * ## 迁移目录与属主清单显式传本仓的
 *
 * 门的实现是从 `aidcp-transport` 这个**包**里 import 的，那份实现「往上两级」的默认基准指向
 * 包目录，那里没有 `migrations/`。不显式传就会撞上包里那道空目录守卫。形态与内容进程一致。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PgOwner } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';
import { loadMigrationFiles } from 'aidcp-transport/schema/migration-files.js';
import {
  loadMigrationOwnerScopes,
  loadTableOwnership,
  type MigrationOwnerScopes,
} from 'aidcp-transport/schema/migration-owners.js';
import {
  runSchemaContractGate,
  type LedgerQueryable,
  type SchemaGateResult,
} from 'aidcp-transport/schema/schema-gate.js';
import type { SchemaGateMode } from 'aidcp-transport/schema/schema-contract.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 本进程打开的属主库集合。**唯一定义处**——门的取值、回执的自检都从这里取。
 *
 * 别在第二处手写一遍 `['api']`：同一份名单被手抄第二遍时，拼错也照样编译过、
 * 少写一项测试全绿（本项目已为此付过多次代价）。
 */
export const API_PG_OWNERS = ['api'] as const satisfies readonly PgOwner[];

/** 只有本模块能造回执的凭据；`unique symbol` 不导出 ⇒ 外部无法拼一个字面量出来。 */
declare const API_SCHEMA_GATE_RECEIPT: unique symbol;

/**
 * 门跑过了的**回执**。
 *
 * 做成不可伪造的凭证、并让启动路径必填持有它，是为了把「门必须先跑、且跑在建池之前」
 * 变成**编译期可见**的顺序约束：想启动就必须先真的调过一次门。
 * 布尔做不到这件事——它可以被任何地方拼出来，包括漏调门的那条路径。
 */
export interface ApiSchemaGateReceipt {
  readonly [API_SCHEMA_GATE_RECEIPT]: true;
  /** 实际判定过的属主。恒为 {@link API_PG_OWNERS}。 */
  readonly owners: readonly PgOwner[];
  readonly mode: SchemaGateMode;
  /** 逐属主结论文本里最严重的那条（全通过时即唯一那条）。 */
  readonly conclusion: string;
  /** warn 模式下可能为 false —— enforce 模式下 false 根本走不到这里（门自己抛）。 */
  readonly pass: boolean;
}

/**
 * `main()` 的**第一句**，建池之前。
 *
 * **MUST NOT 包 try/catch**：吞掉它就等于恢复「schema 落后照样启动」的静默假成功，
 * 而这道门是 fail-closed 的全部价值所在。enforce 模式下门自己抛，异常一路冒到入口外、
 * 进程以非 0 退出、systemd 重启——这是设计。
 *
 * 参数只为测试注入而存在（账本桩 / 判据加载器 / 模式）；生产上一律不传。
 */
export async function runApiStartupSchemaGate(options?: {
  client?: LedgerQueryable;
  clients?: Partial<Record<PgOwner, LedgerQueryable>>;
  mode?: SchemaGateMode;
  loadScopes?: () => Promise<MigrationOwnerScopes>;
}): Promise<ApiSchemaGateReceipt> {
  const result: SchemaGateResult = await runSchemaContractGate({
    ...options,
    owners: API_PG_OWNERS,
    loadScopes:
      options?.loadScopes
      ?? (() =>
        loadMigrationOwnerScopes(
          () => loadMigrationFiles(path.join(REPO_ROOT, 'migrations')),
          () => loadTableOwnership(path.join(REPO_ROOT, 'boundaries', 'table-ownership.json')),
        )),
    // 日志前缀：不传的话打出来的是 `[aidcp-cloud]`（这份实现的事实源在单体）。
    // 门拒绝启动时这条日志是 journal 里唯一的线索，打成别的服务名会把排查直接引偏。
    serviceLabel: 'aidcp-api',
  });
  // 先按**去掉品牌位的完整形状**构造，再只把品牌位强转上去。整体强转会连「四个字段写全没有」
  // 一起静音。
  const receipt: Omit<ApiSchemaGateReceipt, typeof API_SCHEMA_GATE_RECEIPT> = {
    owners: result.owners.map((entry) => entry.owner),
    mode: result.mode,
    conclusion: result.conclusion,
    pass: result.pass,
  };
  return receipt as ApiSchemaGateReceipt;
}
