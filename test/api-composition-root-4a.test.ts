import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const serverUrl = new URL('../src/server.ts', import.meta.url);

test('4a API root owns one API pool, 16 owner route groups, and four outbound command clients', async () => {
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

test('publish owner mutation result is independent from one-way UI delivery', async () => {
  const source = await readFile(serverUrl, 'utf8');
  assert.match(source, /const result = await publishLogStore\.editDraft\(/);
  assert.match(source, /void publishUi\.pushPreview\(recordId\)\.catch\(/);
  assert.match(source, /return result;/);
  assert.match(source, /const rejected = await publishLogStore\.rejectPendingApproval\(recordId\)/);
  assert.match(source, /void publishUi[\s\S]*?\.pushState\(/);
  assert.match(source, /return rejected;/);
});
