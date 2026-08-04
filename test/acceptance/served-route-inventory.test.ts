/**
 * 本进程「到底服务哪些路由族」的清单闸（照 aidcp-automation 同名用例的形态）。
 *
 * **它防的是一类已经发生过两次的静默事故**：派生服务的启动入口是手写的、从不自动同步，
 * 它注册的路由集合会悄悄少于单体。少了的后果不是编译错误 —— 客户端建得出来（构造函数
 * 只吃基址与令牌）、调用点编译得过（类型描述形状、不描述「对面有没有这条路由」）、
 * 两仓测试各自全绿；**只有两个进程真跑起来才 404**，而那个 404 会被读成「对面版本落后」。
 *
 * 本仓 2026-08-04 实测到的形态：内容进程每分钟打一次「取图片模型失败，沿用保守默认」，
 * 而本进程的启动日志同时打着「未注册=无」—— 那份能力清单是人工数组，与实际注册无关。
 *
 * 两个方向都要锁，因为**漏登记比漏注册更危险**：漏注册至少还有人在等那条路由，
 * 漏登记则是这张清单从此不再代表事实，而没有任何东西会说出来。
 *   ① 清单里的每一族 MUST 真的在启动装配里被注册；
 *   ② 启动装配里注册的每一族 MUST 在清单里。
 *
 * 加一族 = 在 {@link SERVED_FAMILIES} 加一行。删一行 = 显式声明「本进程不再服务它」，
 * 那是个需要 review 的判断，不该靠改一行 main() 就悄悄发生。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** 启动装配只有一个文件：本仓的手写组装根。 */
const ASSEMBLY_FILES = ['../../src/server.ts'];

/**
 * 本进程服务的路由族。
 *
 * 只列**族名**、不列路由字符串：路由名与端口方法的对应已由 transport 侧
 * `satisfies Record<keyof Port, string>` 在编译期钉住，这里再抄一份只会多一处会漂的地方。
 */
const SERVED_FAMILIES: readonly string[] = [
  // 4a 属主权威面（automation / content 经内部 HTTP 问本域事实）
  'registerAccountRosterRoutes',
  'registerAccountOwnershipRoutes',
  'registerAccountRuntimeRoutes',
  'registerAccountPersonaRoutes',
  'registerAutomationPublishLogRoutes',
  'registerEdgePublishCommandRoutes',
  'registerInteractionAuthRoutes',
  'registerInteractionApiWritesRoutes',
  'registerReplyConfigResolverRoutes',
  'registerEnvironmentHandshakeRoutes',
  'registerCommentApprovalPolicyRoutes',
  'registerNotificationContactsRoutes',
  'registerFirstPostProgressRoutes',
  'registerAutomationConfigCommandsRoutes',
  'registerOffboardAdmissionLedgerRoutes',
  'registerStructuredNotificationRoutes',
  'registerScheduleFeedbackRoutes',
  // 发布审批
  'registerPublishApprovalAuthorityRoutes',
  'registerPublishApprovalDecisionWriterRoutes',
  // 同步读（本进程是 api 属主流的发布方）
  'registerSyncReadSnapshotRoute',
  'registerSyncReadChangedRoute',
  // 面板事件入口（automation 推进来；对面今天还没有推送方，先让「接得住」成立）
  'registerPanelEventDeliveryRoutes',
  // 内容进程要用的那几族：事实源全是本域属主表 / 本进程无条件构造的组件。
  // 2026-08-04 之前这里**一族都没有**，内容侧因此静默降级。
  'registerRoleModelSelectionRoutes',
  'registerProviderSecretRoutes',
  'registerReviewCardDeliveryRoutes',
  'registerPublishLogRoutes',
  'registerPipelineLogRoutes',
  'registerImageModelSelectionRoutes',
  'registerAccountPlatformRoutes',
  'registerPublishCardExitRoutes',
  // 配置镜像失效信号的落地端（生产方那一侧尚未接线，见组装根注释）
  'registerConfigMirrorBumpRoutes',
];

/**
 * 不是路由族、但名字长得像的调用，逐条豁免并写清理由。
 * MUST NOT 靠放宽正则解决 —— 那会把真正漏登记的一起放过去。
 */
const NOT_A_FAMILY: readonly string[] = [
  // 本仓自己的聚合函数：内部再去调上面那些族。它们**不豁免任何东西** ——
  // 被它们包住的真正族名照样要出现在上面的清单里（内层调用同样带 `server` 实参，正则一样抓得到）。
  'registerApiAuthorityRoutes',
  'registerApiSyncReadOwnerRoute',
  'registerApiSyncReadReadinessRoute',
  'registerApiSyncReadChangedIngress',
];

async function assemblySource(): Promise<string> {
  const parts = await Promise.all(
    ASSEMBLY_FILES.map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  );
  return parts.join('\n');
}

/** 只认**调用**，不认 import：import 了却没调用正是本闸要抓的那件事。 */
function registeredFamilies(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?<![\w.])(register[A-Za-z]*Routes?)\s*\(\s*server\b/g)) {
    found.add(match[1]);
  }
  return found;
}

test('清单里的每一族都真的在启动装配里被注册（漏注册 → 只有真跑两个进程才 404）', async () => {
  const registered = registeredFamilies(await assemblySource());
  const missing = SERVED_FAMILIES.filter((family) => !registered.has(family)).sort();
  assert.deepEqual(
    missing,
    [],
    `清单声明服务、装配里却没注册：\n${missing.join('\n')}\n`
      + '对面调用时会拿到 no route，而那看起来像「版本落后」。',
  );
});

test('启动装配里注册的每一族都在清单里（漏登记是静默的，比漏注册更危险）', async () => {
  const registered = [...registeredFamilies(await assemblySource())];
  const declared = new Set([...SERVED_FAMILIES, ...NOT_A_FAMILY]);
  const unlisted = registered.filter((family) => !declared.has(family)).sort();
  assert.deepEqual(
    unlisted,
    [],
    `装配里注册了、清单里没有：\n${unlisted.join('\n')}\n`
      + '清单一旦不代表事实，就再没有东西会说出漏了什么。',
  );
});

test('清单无重复条目（重复会让「少一族」在计数上看不出来）', () => {
  assert.equal(new Set(SERVED_FAMILIES).size, SERVED_FAMILIES.length);
});
