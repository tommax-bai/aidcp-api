import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { FacebookGroupOpsPort } from 'aidcp-kernel/kernel/facebook-group-ops-types.js';
import type { FacebookScopeCommandPort } from 'aidcp-kernel/kernel/api-direct-port.js';
import type { DispatchDraft } from '../src/publish-agent/publish-log-store.js';
import {
  createApiPanelFacebookGroupTargets,
  createApiPublishOwnerHandlers,
} from '../src/server.js';

const serverUrl = new URL('../src/server.ts', import.meta.url);

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
  const handlers = createApiPublishOwnerHandlers({
    publishLog: {
      loadForDispatch: async (recordId) => draft(recordId),
      editDraft: async (recordId, expectedVersion, patch, editor) => {
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
    },
    approvalClient: { readApproval: async () => null },
    writeApprovalDecision: async (requestId, approved, payload, context) => {
      writes.push({ requestId, approved, payload, context });
      return { written: true, revision: 7 };
    },
    triggerApproved: async () => {},
    publishUi: {
      pushPreview: async (recordId) => {
        previews.push(recordId);
        return { outcome: 'no_record', recordId };
      },
    },
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
  assert.deepEqual(previews, [89]);

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
    publishUi: {
      pushPreview: async (recordId) => ({ outcome: 'no_record', recordId }),
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
