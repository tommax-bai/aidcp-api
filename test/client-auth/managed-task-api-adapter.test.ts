import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CancelManagedTaskResult,
  CreateManagedTaskInput,
  CreateManagedTaskResult,
  ManagedTaskActor,
  ManagedTaskCommandPort,
  ManagedTaskEnvelope,
  QueryManagedTaskResult,
} from 'aidcp-managed-task-transport/transport/managed-task-http.js';
import {
  ClientUserManagedTaskAuthorization,
  ManagedTaskApiOwnerAdapter,
  managedTaskCancelPayloadHash,
  managedTaskCreatePayloadHash,
  type ManagedTaskAccountAuthorizationPort,
  type ManagedTaskApiCancelRequest,
  type ManagedTaskApiCreateRequest,
  type ManagedTaskApiQueryRequest,
} from '../../src/client-auth/managed-task-api-adapter.js';

const ACTOR: ManagedTaskActor = {
  kind: 'customer',
  actorId: 'customer-1',
  customerId: 'customer-1',
  authorizationRevision: 'jwt:jti-1',
};

function createRequest(): ManagedTaskApiCreateRequest {
  return {
    actor: ACTOR,
    correlationId: 'correlation-1',
    causationId: null,
    commandId: 'command-create-1',
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
    taskDefinition: { id: 'persona.research', version: 1 },
    parameters: { keywords: ['automation'], maxItems: 3 },
    capabilityScope: {
      allow: ['browser.search@1', 'browser.browse@1', 'research.assess@1', 'research.summarize@1'],
      deny: [],
    },
    budget: {
      maxBrowserMinutes: 20,
      maxSteps: 4,
      maxExecutionAttempts: 3,
      maxWaitMs: 900_000,
    },
    schedule: {
      scheduledAt: 1_000,
      latestStartAt: 2_000,
      missPolicy: 'skip',
    },
  };
}

function cancelRequest(): ManagedTaskApiCancelRequest {
  return {
    actor: ACTOR,
    correlationId: 'correlation-2',
    causationId: 'correlation-1',
    commandId: 'command-cancel-1',
    accountId: 'account-1',
    taskId: 'task-1',
    expectedAggregateVersion: 1,
    reason: 'customer requested cancellation',
  };
}

function queryRequest(accountId = 'account-1'): ManagedTaskApiQueryRequest {
  return {
    actor: ACTOR,
    correlationId: 'correlation-query-1',
    causationId: null,
    requestId: 'request-query-1',
    accountId,
    taskId: 'task-1',
  };
}

interface PortFake {
  port: ManagedTaskCommandPort;
  creates: ManagedTaskEnvelope<CreateManagedTaskInput>[];
  cancels: unknown[];
  queries: unknown[];
  createResult: CreateManagedTaskResult;
  cancelResult: CancelManagedTaskResult;
  queryResult: QueryManagedTaskResult;
}

function portFake(): PortFake {
  const fake: PortFake = {
    creates: [],
    cancels: [],
    queries: [],
    createResult: {
      outcome: 'applied',
      commandId: 'command-create-1',
      taskId: 'task-1',
      runId: 'run-1',
      aggregateVersion: 1,
    },
    cancelResult: {
      outcome: 'applied',
      commandId: 'command-cancel-1',
      taskId: 'task-1',
      aggregateVersion: 2,
      dispatchedAttemptReconciliationContinues: false,
    },
    queryResult: { outcome: 'not_found' },
    port: undefined as unknown as ManagedTaskCommandPort,
  };
  fake.port = {
    async create(value) {
      fake.creates.push(value);
      return fake.createResult;
    },
    async cancel(value) {
      fake.cancels.push(value);
      return fake.cancelResult;
    },
    async query(value) {
      fake.queries.push(value);
      return fake.queryResult;
    },
  };
  return fake;
}

const allowed: ManagedTaskAccountAuthorizationPort = {
  async authorize(request) {
    return { ok: true, authorizationRevision: request.actor.authorizationRevision };
  },
};

test('authorized create injects target/contract, hashes canonically, and calls only Automation', async () => {
  const fake = portFake();
  const adapter = new ManagedTaskApiOwnerAdapter({
    executionTarget: 'dev',
    authorization: allowed,
    automation: fake.port,
  });

  assert.deepEqual(await adapter.create(createRequest()), fake.createResult);
  assert.equal(fake.creates.length, 1);
  const sent = fake.creates[0]!;
  assert.deepEqual(sent.contract, { name: 'managed-task', version: 1 });
  assert.equal(sent.executionTarget, 'dev');
  assert.equal(sent.correlationId, 'correlation-1');
  assert.equal(sent.causationId, null);
  assert.equal(sent.input.payloadHash, managedTaskCreatePayloadHash(sent.input));
  assert.equal(
    sent.input.payloadHash,
    'b7606b4efc754ab97e024d96bfa3a576bb246044dcbb014928ecd183960825d0',
  );
  assert.deepEqual(fake.cancels, []);
  assert.deepEqual(fake.queries, []);
});

test('canonical hashes are independent of JSON object key insertion order', () => {
  const request = createRequest();
  const reversedParameters = {
    maxItems: 3,
    keywords: ['automation'],
  };
  assert.equal(
    managedTaskCreatePayloadHash({ ...request, parameters: reversedParameters }),
    managedTaskCreatePayloadHash(request),
  );
  assert.equal(
    managedTaskCancelPayloadHash(cancelRequest()),
    'bf82365cfd7deb75ba5cc01908e90c51e77dc6896c2fd5a76d151b723f149c1a',
  );
});

test('client authority uses customer scope, live enablement, and exact account platform', async () => {
  const calls: string[] = [];
  const authority = new ClientUserManagedTaskAuthorization({
    clients: {
      async resolveBoundAccountForEnv(userId, envKey) {
        calls.push(`forward:${userId}:${envKey}`);
        return { ok: true, accountId: 'account-1' };
      },
      async isAccountReachableByUser(userId, accountId) {
        calls.push(`reverse:${userId}:${accountId}`);
        return { ok: true, accountId };
      },
      async isEnabled(userId) {
        calls.push(`enabled:${userId}`);
        return true;
      },
    },
    accounts: {
      async getPlatformOrNull(accountId) {
        calls.push(`platform:${accountId}`);
        return 'facebook';
      },
    },
  });

  assert.deepEqual(await authority.authorize({
    actor: ACTOR,
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
  }), { ok: true, authorizationRevision: 'jwt:jti-1' });
  assert.deepEqual(calls, [
    'forward:customer-1:env-1',
    'enabled:customer-1',
    'platform:account-1',
  ]);

  calls.length = 0;
  assert.deepEqual(await authority.authorize({ actor: ACTOR, accountId: 'account-1' }), {
    ok: true,
    authorizationRevision: 'jwt:jti-1',
  });
  assert.deepEqual(calls, ['reverse:customer-1:account-1', 'enabled:customer-1']);
});

test('customer identity mismatch, account mismatch, platform mismatch, and contention fail closed', async () => {
  let binding: Awaited<ReturnType<ClientUserManagedTaskAuthorization['authorize']>> | null = null;
  const authority = new ClientUserManagedTaskAuthorization({
    clients: {
      async resolveBoundAccountForEnv() {
        return binding?.ok === false && binding.reason === 'authorization_unavailable'
          ? { ok: false as const, reason: 'binding_unavailable' as const }
          : binding?.ok === false
            ? { ok: false as const, reason: 'binding_conflict' as const }
            : { ok: true as const, accountId: 'another-account' };
      },
      async isAccountReachableByUser(_userId, accountId) {
        return { ok: true, accountId };
      },
      async isEnabled() { return true; },
    },
    accounts: { async getPlatformOrNull() { return 'xiaohongshu'; } },
  });

  assert.deepEqual(await authority.authorize({
    actor: { ...ACTOR, actorId: 'impersonated-customer' },
    accountId: 'account-1',
  }), { ok: false, reason: 'not_authorized' });
  assert.deepEqual(await authority.authorize({
    actor: ACTOR,
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
  }), { ok: false, reason: 'not_authorized' });

  binding = { ok: false, reason: 'not_authorized' };
  assert.deepEqual(await authority.authorize({
    actor: ACTOR,
    accountId: 'account-1',
    envKey: 'env-1',
  }), { ok: false, reason: 'not_authorized' });

  binding = { ok: false, reason: 'authorization_unavailable' };
  assert.deepEqual(await authority.authorize({
    actor: ACTOR,
    accountId: 'account-1',
    envKey: 'env-1',
  }), { ok: false, reason: 'authorization_unavailable' });
});

test('cross-account query denial uses common not_found and never calls Automation', async () => {
  const fake = portFake();
  const adapter = new ManagedTaskApiOwnerAdapter({
    executionTarget: 'dev',
    authorization: { async authorize() { return { ok: false, reason: 'not_authorized' }; } },
    automation: fake.port,
  });

  assert.deepEqual(await adapter.query(queryRequest('another-account')), { outcome: 'not_found' });
  assert.deepEqual(fake.queries, []);
});

test('authorization outage stays unavailable; stale revision is denied before owner call', async () => {
  const fake = portFake();
  const unavailable = new ManagedTaskApiOwnerAdapter({
    executionTarget: 'dev',
    authorization: {
      async authorize() { return { ok: false, reason: 'authorization_unavailable' }; },
    },
    automation: fake.port,
  });
  assert.deepEqual(await unavailable.create(createRequest()), {
    outcome: 'unavailable',
    reason: 'managed_task_authorization_unavailable',
  });
  assert.deepEqual(await unavailable.query(queryRequest()), {
    outcome: 'unavailable',
    reason: 'managed_task_authorization_unavailable',
  });

  const stale = new ManagedTaskApiOwnerAdapter({
    executionTarget: 'dev',
    authorization: {
      async authorize() { return { ok: true, authorizationRevision: 'jwt:new-jti' }; },
    },
    automation: fake.port,
  });
  assert.deepEqual(await stale.cancel(cancelRequest()), {
    outcome: 'rejected',
    code: 'account_not_authorized',
    message: 'actor/account authorization is absent or stale',
  });
  assert.deepEqual(fake.creates, []);
  assert.deepEqual(fake.cancels, []);
  assert.deepEqual(fake.queries, []);
});

test('ambiguous create/cancel and before/after-dispatch cancellation receipts pass through once', async () => {
  const fake = portFake();
  const adapter = new ManagedTaskApiOwnerAdapter({
    executionTarget: 'dev',
    authorization: allowed,
    automation: fake.port,
  });

  fake.createResult = {
    outcome: 'result_unknown',
    commandId: 'command-create-1',
    lookupRequired: true,
  };
  assert.deepEqual(await adapter.create(createRequest()), fake.createResult);
  assert.equal(fake.creates.length, 1);

  for (const reconciliationContinues of [false, true]) {
    fake.cancelResult = {
      outcome: 'applied',
      commandId: 'command-cancel-1',
      taskId: 'task-1',
      aggregateVersion: 2,
      dispatchedAttemptReconciliationContinues: reconciliationContinues,
    };
    assert.deepEqual(await adapter.cancel(cancelRequest()), fake.cancelResult);
  }
  assert.equal(fake.cancels.length, 2);

  fake.cancelResult = {
    outcome: 'result_unknown',
    commandId: 'command-cancel-1',
    lookupRequired: true,
  };
  assert.deepEqual(await adapter.cancel(cancelRequest()), fake.cancelResult);
  assert.equal(fake.cancels.length, 3);
});
