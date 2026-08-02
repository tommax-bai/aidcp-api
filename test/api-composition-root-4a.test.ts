// aidcp:test-owner=derived
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { FacebookGroupOpsPort } from 'aidcp-kernel/kernel/facebook-group-ops-types.js';
import type {
  AutomationPublishLogPort,
  FacebookScopeCommandPort,
} from 'aidcp-kernel/kernel/api-direct-port.js';
import type { DispatchDraft } from '../src/publish-agent/publish-log-store.js';
import {
  createApiPanelFacebookGroupTargets,
  createApiPublishLogAuthority,
  createApiPublishOwnerHandlers,
} from '../src/server.js';

const serverUrl = new URL('../src/server.ts', import.meta.url);

/**
 * 结构断言一律读**剥掉注释**的源码：本文件里解释红线的注释本身就带着被禁的字面量
 * （「MUST NOT 压成 `active:false`」那句），按整文件匹配会被自己的注释命中。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** 命令面构造块（到 `managementChatIds` 那个字段为止），用于把断言锚在构造处而不是整文件。 */
function commandFaceBlock(code: string): string {
  const start = code.indexOf('apiFeishu.createCommandFace(');
  assert.ok(start > 0, '本进程 MUST 自己构造飞书命令面');
  const end = code.indexOf('managementChatIds,', start);
  assert.ok(end > start, '命令面构造块 MUST 以 managementChatIds 收尾');
  return code.slice(start, end);
}

test('4a API root owns one API pool, 16 owner route groups, two 3b approval groups, and four outbound command clients', async () => {
  const source = await readFile(serverUrl, 'utf8');
  assert.match(source, /new pg\.Pool\(\{ \.\.\.resolveOwnerPgConfig\('api'\), max: 30 \}\)/);
  assert.equal((source.match(/new pg\.Pool\(/g) ?? []).length, 1);

  for (const registrar of [
    'registerAccountRosterRoutes',
    'registerAccountOwnershipRoutes',
    'registerAccountRuntimeRoutes',
    'registerAutomationPublishLogRoutes',
    'registerEdgePublishCommandRoutes',
    'registerInteractionAuthRoutes',
    'registerInteractionApiWritesRoutes',
    'registerReplyConfigResolverRoutes',
    'registerAccountPersonaRoutes',
    'registerEnvironmentHandshakeRoutes',
    'registerCommentApprovalPolicyRoutes',
    'registerNotificationContactsRoutes',
    'registerFirstPostProgressRoutes',
    'registerAutomationConfigCommandsRoutes',
    'registerOffboardAdmissionLedgerRoutes',
    'registerStructuredNotificationRoutes',
  ]) {
    assert.match(source, new RegExp(`${registrar}\\(server, port\\.`));
  }
  assert.match(source, /registerPublishApprovalAuthorityRoutes\(/);
  assert.match(source, /registerPublishApprovalDecisionWriterRoutes\(/);

  for (const client of [
    'EdgeResumeCommandHttpClient',
    'FacebookScopeCommandHttpClient',
    'PublishUiUpdateCommandHttpClient',
    'PersonaGeneratorCommandHttpClient',
  ]) {
    assert.match(source, new RegExp(`new ${client}\\(`));
  }
});

test('调度启停：本进程真建那个跨进程客户端，写分三种回执、读保持三态', async () => {
  // 这条守的是三件「不报错、只是悄悄变成假答案」的事：
  // ① 又退回 `automation_operator_command_unavailable:dispatch` 那种「一调就抛」；
  // ② 三种非成功回执被压成一句「失败」，运营再也分不出「没送到」与「键撞了」；
  // ③ 状态读被 catch 成 `active:false` —— 把「读不到调度引擎」画成「引擎正常停着」，
  //    运营看到后者什么都不会做，而真相是这条链根本不通。
  const code = stripComments(await readFile(serverUrl, 'utf8'));
  assert.match(
    code,
    /new AutomationDispatchCommandHttpClient\(\s*automationHttp,\s*automationToken,\s*target,?\s*\)/,
    '客户端 MUST 指向 automation 且 target 由构造参数注入（调用方无从自选）',
  );
  assert.doesNotMatch(
    code,
    /automation_operator_command_unavailable:dispatch/,
    '接上之后那句「这条通道不可用」MUST 自熄，否则台账探针分不出「没通道」与「没配通道」',
  );

  const block = commandFaceBlock(code);
  assert.match(block, /automationDispatchCommand\.setDispatch\(/, '写 MUST 走那个客户端');
  assert.match(block, /receipt\.outcome === 'not_delivered'/, '「没送达」MUST 单独说');
  assert.match(block, /receipt\.outcome === 'collision'/, '「键撞了」MUST 单独说');
  assert.match(
    block,
    /return receipt\.state;/,
    '回执里的 state 与面板要的形状逐字相同，MUST 原样回传、不重组新对象',
  );
  assert.match(
    block,
    /dispatchActive: \(\) => automationDispatchCommand\.readDispatchActivity\(\)/,
    '状态灯 MUST 原样委托给那条读，三态一路透到面板',
  );
  assert.doesNotMatch(
    block,
    /active:\s*false/,
    '读不到 MUST NOT 被压成 active:false（这正是本文件历史上写过的那句 `() => false`）',
  );
});

test('撤权保持读 MUST 委托客户花名册属主那一份，不在台账类里抄第二条 SQL', async () => {
  // 台账类只实现写面（`implements Omit<…, 'hasPendingRevocationHold'>`），读面要按账号解析环境键。
  // 抄第二份的现形方式不是报错，而是某天两份谓词漂开、一个正在被撤权的环境被重新放行。
  // **这一处曾让本仓 typecheck 整个红着**：端口新增这个方法随同步进了本仓，
  // 而手写入口从不同步、没人跟着补 —— 派生入口与单体入口不是同一份，第五次。
  const code = stripComments(await readFile(serverUrl, 'utf8'));
  assert.match(
    code,
    /hasPendingRevocationHold: \(accountId: string\) =>\s*clientUserStore\.hasPendingRevocationHold\(accountId\)/,
  );
});

test('4a API root does not reconstruct automation/content graphs and Feishu is API composed', async () => {
  const source = await readFile(serverUrl, 'utf8');
  for (const forbidden of [
    "'./risk/",
    "'./comm/",
    "'./agents/",
    "'./orchestrator/",
    "'./llm/",
    'RiskController',
    'RoleDispatcher',
    'PersonaGenerator(',
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(source, /await import\('\.\/feishu\/api-owner-composition\.js'\)/);
  assert.match(source, /apiFeishu\.notificationDelivery/);
  assert.match(source, /await apiFeishu\.startIngress\(/);
});

function draft(recordId = 89): DispatchDraft {
  return {
    recordId,
    accountId: 'acc-1',
    title: 'Owner draft',
    content: 'Body',
    imageUrl: 'https://img/a.jpg',
    imageUrls: ['https://img/a.jpg', 'https://img/b.jpg'],
    metadata: { topics: ['owner'] },
    status: 'pending_approval',
    contentVersion: 4,
  } as DispatchDraft;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('Edge publish routes execute the API owner draft CAS and 3b approval writer', async () => {
  const edits: unknown[] = [];
  const writes: unknown[] = [];
  const previews: number[] = [];
  const owner = {
      loadForDispatch: async (recordId: number) => draft(recordId),
      editDraft: async (
        recordId: number,
        expectedVersion: number,
        patch: Parameters<AutomationPublishLogPort['editDraft']>[2],
        editor: string,
      ) => {
        edits.push({ recordId, expectedVersion, patch, editor });
        return {
          ok: true,
          contentVersion: expectedVersion + 1,
          title: 'Owner draft',
          content: 'Body',
          metadata: draft().metadata,
          images: ['https://img/a.jpg'],
        };
      },
      rejectPendingApproval: async () => true,
    } as unknown as AutomationPublishLogPort;
  const publishLog = createApiPublishLogAuthority(
    owner,
    {
      pushPreview: async (recordId) => {
        previews.push(recordId);
        return { outcome: 'no_record', recordId };
      },
      pushState: async (accountId, recordId) => ({
        outcome: 'applied',
        commandId: `state:${recordId}`,
        accountId,
      }),
    },
    { warn: () => {} },
  );
  const handlers = createApiPublishOwnerHandlers({
    publishLog,
    approvalClient: { readApproval: async () => null },
    writeApprovalDecision: async (requestId, approved, payload, context) => {
      writes.push({ requestId, approved, payload, context });
      return { written: true, revision: 7 };
    },
    triggerApproved: async () => {},
    logger: { warn: () => {} },
  });

  const removed = await handlers.edgePublish.removeDraftImage({
    payload: {
      requestId: 'publish-89',
      contentVersion: 4,
      imageUrl: 'https://img/b.jpg',
    },
    session: { accountId: 'acc-1', actor: 'edge:one' },
  });
  assert.deepEqual(removed, {
    requestId: 'publish-89',
    ok: true,
    images: ['https://img/a.jpg'],
    contentVersion: 5,
  });
  assert.deepEqual(edits, [{
    recordId: 89,
    expectedVersion: 4,
    patch: { images: ['https://img/a.jpg'] },
    editor: 'edge:one',
  }]);
  await nextTurn();
  assert.deepEqual(previews, [89], 'successful owner edit emits exactly one preview');

  const decided = await handlers.edgePublish.decidePublishApproval({
    payload: { requestId: 'publish-89', approved: true, contentVersion: 4 },
    accountId: 'acc-1',
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.state, 'approved');
  assert.deepEqual(writes, [{
    requestId: 'publish-89',
    approved: true,
    payload: {
      title: 'Owner draft',
      content: 'Body',
      tags: ['owner'],
      contentVersion: 4,
    },
    context: {
      decidedBy: 'client:acc-1',
      decidedVia: 'client',
    },
  }]);
});

test('Feishu ingress reuses the 3b writer, live-version/preflight, approve trigger, and rejection materialization', async () => {
  const writes: unknown[] = [];
  const triggers: unknown[] = [];
  const rejected: number[] = [];
  const handlers = createApiPublishOwnerHandlers({
    publishLog: {
      loadForDispatch: async (recordId) => recordId === 89 ? draft(recordId) : null,
      editDraft: async () => ({ ok: false, reason: 'not_found' }),
      rejectPendingApproval: async (recordId) => {
        rejected.push(recordId);
        return true;
      },
    },
    approvalClient: { readApproval: async () => null },
    writeApprovalDecision: async (requestId, approved, payload, context) => {
      writes.push({ requestId, approved, payload, context });
      return { written: true, revision: 8 };
    },
    triggerApproved: async (requestId, revision, kind) => {
      triggers.push({ requestId, revision, kind });
    },
    logger: { warn: () => {} },
  });
  const ingress = handlers.feishuApprovalIngress;
  const payload = { title: 't', content: 'c', tags: [], contentVersion: 4 };
  assert.deepEqual(
    await ingress.writeApproval(
      'publish-89',
      true,
      payload,
      { decidedBy: 'ou_real', decidedVia: 'feishu' },
    ),
    { written: true, revision: 8 },
  );
  assert.deepEqual(writes[0], {
    requestId: 'publish-89',
    approved: true,
    payload,
    context: { decidedBy: 'ou_real', decidedVia: 'feishu' },
  });
  assert.equal(await ingress.readLiveContentVersion?.(89), 4);
  assert.deepEqual(await ingress.preflightApprovePublish?.('publish-89', payload), {
    ok: true,
    accountId: 'acc-1',
  });
  assert.deepEqual(await ingress.preflightApprovePublish?.('publish-999', payload), {
    ok: false,
    reason: 'publish_target_unavailable',
  });
  ingress.onApproved?.({ requestId: 'publish-89', revision: 8, kind: 'human_reconfirm' });
  ingress.onRejected?.('publish-89');
  await nextTurn();
  assert.deepEqual(triggers, [{
    requestId: 'publish-89',
    revision: 8,
    kind: 'human_reconfirm',
  }]);
  assert.deepEqual(rejected, [89]);
});

test('API panel Facebook writes use the target-bound command client while reads keep the 3a operation client', async () => {
  const commandCalls: unknown[] = [];
  const commands: FacebookScopeCommandPort = {
    async importTargets(input) {
      commandCalls.push({ method: 'importTargets', input });
      return {
        outcome: 'applied',
        commandId: input.commandId,
        result: { imported: 1, updated: 0, duplicate: 0, invalid: 0, rows: [] },
      };
    },
    async replaceTargetScopes(input) {
      commandCalls.push({ method: 'replaceTargetScopes', input });
      return {
        outcome: 'applied',
        commandId: input.commandId,
        result: { ok: true, items: [] },
      };
    },
  };
  const reads = {
    listTargets: async () => ({ items: [], total: 0 }),
    listFacets: async () => ({ statuses: [], accountGroupLabels: [] }),
    setEnabled: async () => null,
    accountProgress: async () => [],
    listAssignments: async () => [],
    reclaimStaleAssignments: async () => 0,
  } as unknown as FacebookGroupOpsPort;
  const ids = ['scope-import', 'scope-replace'][Symbol.iterator]();
  const panel = createApiPanelFacebookGroupTargets(
    reads,
    commands,
    () => ids.next().value ?? 'unexpected',
  );

  const imported = await panel.importTargets(
    [{ url: 'https://facebook.com/groups/one' }],
    'batch-1',
    { accountGroupLabels: ['team-a'], updatedBy: 'operator' },
  );
  assert.equal(imported.imported, 1);
  assert.deepEqual(
    await panel.replaceTargetScopes(
      ['https://facebook.com/groups/one'],
      ['team-a'],
      'operator',
    ),
    { ok: true, items: [] },
  );
  assert.deepEqual(commandCalls, [
    {
      method: 'importTargets',
      input: {
        commandId: 'scope-import',
        inputs: [{ url: 'https://facebook.com/groups/one' }],
        importBatch: 'batch-1',
        options: { accountGroupLabels: ['team-a'], updatedBy: 'operator' },
      },
    },
    {
      method: 'replaceTargetScopes',
      input: {
        commandId: 'scope-replace',
        groupUrls: ['https://facebook.com/groups/one'],
        accountGroupLabels: ['team-a'],
        updatedBy: 'operator',
      },
    },
  ]);
});
