// aidcp:test-owner=derived
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isSyncReadFactPayload,
  makeSyncReadFactEnvelope,
  type SyncReadPayloadByStream,
} from 'aidcp-kernel/kernel/sync-read-facts.js';
import type {
  SyncReadConsumerCheckpoint,
  SyncReadJson,
  SyncReadSnapshotEnvelope,
  SyncReadStream,
} from 'aidcp-kernel/kernel/sync-read-snapshot.js';
import {
  InternalHttpClient,
  InternalHttpServer,
} from 'aidcp-transport/transport/internal-http.js';
import {
  SYNC_READ_CHANGED_ROUTE,
  SyncReadChangedHttpClient,
} from 'aidcp-transport/transport/sync-read-changed-http.js';
import { SyncReadSnapshotHttpClient } from 'aidcp-transport/transport/sync-read-snapshot-http.js';

import { ApiSyncReadMirrors } from '../src/config/api-sync-read-mirrors.js';
import { API_OWNED_SYNC_READ_STREAMS } from '../src/config/api-sync-read-source.js';
import {
  API_SYNC_READ_CHANGED_STREAMS,
  API_SYNC_READ_CONSUMED_STREAMS,
  API_SYNC_READ_OWNED_STREAMS,
  API_SYNC_READ_PUBLIC_SURFACE_LEDGER,
  ApiSyncReadConsumerRuntime,
  createApiSyncReadPanelEvidencePorts,
  registerApiSyncReadChangedIngress,
  registerApiSyncReadOwnerRoute,
  type ApiSyncReadCheckpointPort,
  type ApiSyncReadSnapshotClient,
} from '../src/server.js';

type ConsumedStream = (typeof API_SYNC_READ_CONSUMED_STREAMS)[number];

function payload(stream: ConsumedStream): SyncReadPayloadByStream[ConsumedStream] {
  switch (stream) {
    case 'session_config_global':
      return { weekActiveMask: '1111100' };
    case 'edge_presence':
      return {
        edgeCount: 0,
        onlineEdgeCount: 0,
        accountEdges: [],
      };
    case 'publish_in_flight':
      return { recordIds: [] };
    case 'captcha_availability':
      return { state: 'available' };
    case 'automation_config_mirror_health':
      return {
        sourceService: 'automation',
        enabled: true,
        pollMs: 5_000,
        entries: [],
      };
  }
}

function envelope(
  stream: ConsumedStream,
  observedAt: number,
  cursor = '1',
): SyncReadSnapshotEnvelope {
  return makeSyncReadFactEnvelope({
    executionTarget: 'dev',
    stream,
    cursor,
    asOf: observedAt,
    freshUntil: observedAt + 500,
    value: payload(stream) as never,
  });
}

class FakeSnapshotClient implements ApiSyncReadSnapshotClient {
  readonly failures = new Set<ConsumedStream>();
  readonly cursors = new Map<ConsumedStream, string>();
  observedAt = 100;

  constructor(private readonly calls: string[]) {}

  async fetch<T extends SyncReadJson = SyncReadJson>(
    stream: SyncReadStream,
    validateValue?: (value: unknown) => value is T,
  ): Promise<SyncReadSnapshotEnvelope<T>> {
    const consumed = stream as ConsumedStream;
    this.calls.push(`fetch:${consumed}`);
    if (this.failures.has(consumed)) {
      throw new Error(`owner_unavailable:${consumed}`);
    }
    const snapshot = envelope(
      consumed,
      this.observedAt,
      this.cursors.get(consumed) ?? '1',
    );
    assert.equal(
      validateValue?.(snapshot.value) ?? isSyncReadFactPayload(stream, snapshot.value),
      true,
    );
    return snapshot as SyncReadSnapshotEnvelope<T>;
  }
}

function checkpointPort(
  calls: string[],
  rejectStream?: ConsumedStream,
): ApiSyncReadCheckpointPort {
  return {
    async load(stream) {
      calls.push(`load:${stream}`);
      return { outcome: 'not_found', checkpoint: null };
    },
    async save(input) {
      const checkpoint = input as SyncReadConsumerCheckpoint;
      calls.push(`save:${checkpoint.stream}`);
      if (checkpoint.stream === rejectStream) {
        return {
          outcome: 'rejected',
          reason: 'old_cursor',
          currentCursor: '2',
          message: 'concurrent checkpoint is newer',
        };
      }
      return { outcome: 'stored', checkpoint };
    },
  };
}

test('4b API mirror bootstrap restores every target checkpoint before authenticated owner fetch and save', async () => {
  const calls: string[] = [];
  const mirrors = new ApiSyncReadMirrors('dev', () => 100);
  const client = new FakeSnapshotClient(calls);
  const runtime = new ApiSyncReadConsumerRuntime(
    mirrors,
    checkpointPort(calls),
    client,
    { warn: () => {} },
  );

  const report = await runtime.bootstrap();

  assert.deepEqual(report.failures, []);
  assert.equal(report.readiness.state, 'ready');
  assert.deepEqual(
    calls.slice(0, API_SYNC_READ_CONSUMED_STREAMS.length),
    API_SYNC_READ_CONSUMED_STREAMS.map((stream) => `load:${stream}`),
  );
  for (const stream of API_SYNC_READ_CONSUMED_STREAMS) {
    assert.ok(calls.indexOf(`fetch:${stream}`) > calls.indexOf(`load:${stream}`));
    assert.ok(calls.indexOf(`save:${stream}`) > calls.indexOf(`fetch:${stream}`));
  }
  const presence = mirrors.presence();
  assert.equal(presence.state, 'fresh');
  assert.equal(presence.asOf, 100);
  assert.equal(presence.edgeCount, 0);
  assert.equal(presence.onlineEdgeCount, 0);
  assert.equal(presence.resolveEdgeIdForAccount('missing'), null);
  assert.equal(mirrors.inFlightEvidence().recordIds?.size, 0);

  client.observedAt = 120;
  const periodic = await runtime.refreshAll();
  assert.equal(periodic.readiness.state, 'ready');
  for (const stream of API_SYNC_READ_CONSUMED_STREAMS) {
    assert.equal(
      calls.filter((call) => call === `fetch:${stream}`).length,
      2,
      `periodic full refresh must fetch ${stream} even without a notification`,
    );
  }
});

test('4b API first-load and checkpoint failures remain blocker-level unknown and recover by full fetch', async () => {
  const calls: string[] = [];
  const mirrors = new ApiSyncReadMirrors('dev', () => 100);
  const client = new FakeSnapshotClient(calls);
  client.failures.add('edge_presence');
  const runtime = new ApiSyncReadConsumerRuntime(
    mirrors,
    checkpointPort(calls),
    client,
    { warn: () => {} },
  );

  const first = await runtime.bootstrap();
  assert.deepEqual(first.failures.map((failure) => failure.stream), ['edge_presence']);
  assert.equal(first.readiness.state, 'not_ready');
  assert.deepEqual(
    first.readiness.blockers.map((blocker) => blocker.stream),
    ['edge_presence'],
  );
  assert.equal(mirrors.presence().state, 'unknown');
  assert.equal(mirrors.presence().onlineEdgeCount, null);
  const health = runtime.health();
  assert.equal(health.readiness.state, 'not_ready');
  assert.equal(
    health.streams.find((stream) => stream.stream === 'edge_presence')?.state,
    'recovering',
  );
  assert.match(
    health.streams.find((stream) => stream.stream === 'edge_presence')
      ?.lastError ?? '',
    /owner_unavailable:edge_presence/,
  );

  client.failures.delete('edge_presence');
  client.observedAt = 120;
  await runtime.refreshStream('edge_presence');
  assert.equal(runtime.readiness().state, 'ready');
  assert.equal(mirrors.presence().state, 'fresh');

  const persistMirrors = new ApiSyncReadMirrors('dev', () => 100);
  const persistRuntime = new ApiSyncReadConsumerRuntime(
    persistMirrors,
    checkpointPort([], 'edge_presence'),
    new FakeSnapshotClient([]),
    { warn: () => {} },
  );
  const persistReport = await persistRuntime.bootstrap();
  assert.deepEqual(
    persistReport.failures.map((failure) => failure.stream),
    ['edge_presence'],
  );
  assert.equal(persistMirrors.presence().state, 'unknown');
  assert.equal(persistRuntime.readiness().state, 'not_ready');
});

test('4b API panel evidence adapters preserve fresh zero and make unavailable sections empty', async () => {
  const mirrors = new ApiSyncReadMirrors('dev', () => 100);
  const ports = createApiSyncReadPanelEvidencePorts(mirrors);
  assert.deepEqual(ports.edgePresenceEvidence?.(), {
    state: 'unknown',
    asOf: null,
    onlineEdgeCount: null,
  });
  assert.equal(ports.publishInFlightEvidence?.().recordIds, null);

  for (const stream of API_SYNC_READ_CONSUMED_STREAMS) {
    mirrors.apply(envelope(stream, 100), 'owner_fetch');
  }
  assert.deepEqual(ports.edgePresenceEvidence?.(), {
    state: 'fresh',
    asOf: 100,
    onlineEdgeCount: 0,
  });
  assert.equal(ports.publishInFlightEvidence?.().recordIds?.size, 0);
  const services = ports.configMirrorServicesHealth?.().services ?? [];
  assert.deepEqual(services.map((service) => service.sourceService), [
    'api',
    'automation',
  ]);
  assert.equal(services[0]?.deliveryState, 'fresh');
  assert.equal(services[1]?.deliveryState, 'fresh');

  assert.deepEqual(API_SYNC_READ_PUBLIC_SURFACE_LEDGER, [
    {
      surface: 'GET /api/dashboard/summary',
      owner: 'cloud-panel',
      adapter: 'edgePresenceEvidence',
    },
    {
      surface: 'GET /api/content/queue',
      owner: 'cloud-panel',
      adapter: 'publishInFlightEvidence',
    },
    {
      surface: 'GET /api/config-mirrors',
      owner: 'cloud-panel',
      adapter: 'configMirrorServicesHealth',
    },
  ]);
});

test('4b API owner route serves only B1/B2/B4/B5 streams with target-bound auth', async () => {
  const server = new InternalHttpServer();
  registerApiSyncReadOwnerRoute(
    server,
    {
      async snapshotFor({ stream, executionTarget }) {
        assert.equal(executionTarget, 'dev');
        assert.equal(stream, 'account_persona');
        return makeSyncReadFactEnvelope({
          executionTarget,
          stream: 'account_persona',
          cursor: '4',
          asOf: 100,
          freshUntil: 600,
          value: { accounts: [] },
        });
      },
    },
    'dev',
    'api-secret',
  );
  const port = await server.listen(0);
  try {
    const client = new SyncReadSnapshotHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      { executionTarget: 'dev', bearerToken: 'api-secret' },
    );
    const snapshot = await client.fetch(
      'account_persona',
      (value): value is SyncReadPayloadByStream['account_persona'] =>
        isSyncReadFactPayload('account_persona', value),
    );
    assert.equal(snapshot.cursor, '4');
    assert.deepEqual(snapshot.value, { accounts: [] });
    await assert.rejects(
      client.fetch('edge_presence'),
      /snapshot stream is not served by this owner/,
    );
  } finally {
    await server.close();
  }
  // **按引用断，别再抄第四份。** 这里原本手抄了一份七条的字面量，而属主源那份是八条
  // （多 `facebook_operation_policy`）—— 用例因此把「注册清单漏了一条」这件事一起钉成了「正确」。
  // 真实后果在 dev 上实测过：自动化进程的消费方永远拿不到那条流 ⇒ 就绪度永远 not_ready ⇒
  // 业务入口永不放行 ⇒ 边-云端口不监听、边缘一台都连不上。
  assert.equal(
    API_SYNC_READ_OWNED_STREAMS,
    API_OWNED_SYNC_READ_STREAMS,
    '注册用的流集合 MUST 与属主源那份是同一个清单，不是内容相同的第二份',
  );
  assert.ok(API_SYNC_READ_OWNED_STREAMS.includes('facebook_operation_policy'));
});

test('4b changed ingress ACKs A3-A6 only after generation-bound fetch, apply, and checkpoint save', async () => {
  const calls: string[] = [];
  const mirrors = new ApiSyncReadMirrors('dev', () => 100);
  const snapshots = new FakeSnapshotClient(calls);
  const runtime = new ApiSyncReadConsumerRuntime(
    mirrors,
    checkpointPort(calls),
    snapshots,
    { warn: () => {} },
  );
  assert.equal((await runtime.bootstrap()).readiness.state, 'ready');

  const server = new InternalHttpServer();
  registerApiSyncReadChangedIngress(server, runtime, 'dev', 'api-secret');
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const changed = new SyncReadChangedHttpClient(http, {
      executionTarget: 'dev',
      bearerToken: 'api-secret',
    });
    snapshots.observedAt = 120;
    await changed.deliver({ stream: 'edge_presence', generation: '1' });
    assert.deepEqual(calls.slice(-2), [
      'fetch:edge_presence',
      'save:edge_presence',
    ]);

    await assert.rejects(
      changed.deliver({ stream: 'edge_presence', generation: '2' }),
      /sync_read_snapshot_generation_behind/,
    );
    assert.equal(mirrors.presence().state, 'unknown');
    snapshots.cursors.set('edge_presence', '2');
    snapshots.observedAt = 140;
    await changed.deliver({ stream: 'edge_presence', generation: '2' });
    assert.equal(mirrors.presence().state, 'fresh');

    const wrongTarget = new SyncReadChangedHttpClient(http, {
      executionTarget: 'ol',
      bearerToken: 'api-secret',
    });
    await assert.rejects(
      wrongTarget.deliver({ stream: 'edge_presence', generation: '2' }),
      /target/,
    );
    const wrongToken = new SyncReadChangedHttpClient(http, {
      executionTarget: 'dev',
      bearerToken: 'wrong-secret',
    });
    await assert.rejects(
      wrongToken.deliver({ stream: 'edge_presence', generation: '2' }),
      /auth/,
    );
    await assert.rejects(
      http.callBearer(
        SYNC_READ_CHANGED_ROUTE,
        {
          contractVersion: 1,
          stream: 'session_config_global',
          generation: '2',
        },
        'api-secret',
      ),
      /stream/,
    );
  } finally {
    await server.close();
  }

  assert.deepEqual(API_SYNC_READ_CHANGED_STREAMS, [
    'edge_presence',
    'publish_in_flight',
    'captcha_availability',
    'automation_config_mirror_health',
  ]);
});

test('4b API root listens before first mirror fetch and starts Feishu only behind readiness', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const listenAt = source.indexOf('await server.listen(apiPort())');
  const bootstrapAt = source.indexOf('await root.syncRead.consumer.bootstrap()');
  const businessAt = source.indexOf('await root.business.startIngress()');
  const changedIngressAt = source.indexOf(
    'registerApiSyncReadChangedIngress(\n    server,',
  );
  assert.ok(listenAt >= 0 && bootstrapAt > listenAt);
  assert.ok(businessAt > listenAt);
  assert.ok(
    changedIngressAt >= 0 && changedIngressAt < listenAt,
    'changed ingress must share the owner listener before consumer first load',
  );
  assert.match(
    source,
    /root\.syncRead\.consumer\.readiness\(\)\.state !== 'ready'/,
  );
  assert.match(source, /root\.syncRead\.consumer\.startPeriodic\(/);
  assert.match(source, /root\.syncRead\.consumer\.stop\(\)/);
  assert.match(source, /await server\.close\(\)/);
  assert.match(source, /await root\.pool\.end\(\)/);
  assert.match(source, /if \(closePromise\) return closePromise/);
  assert.doesNotMatch(source, /resolveOwnerPgConfig\('automation'\)/);
  assert.equal((source.match(/new pg\.Pool\(/g) ?? []).length, 1);
});

test('4b API package graph has one exact kernel and transport instance', async () => {
  const lock = JSON.parse(
    await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
  ) as {
    packages: Record<string, {
      dependencies?: Record<string, string>;
      resolved?: string;
    }>;
  };
  const root = lock.packages['']?.dependencies ?? {};
  // Canonical pin form since invert-split-fact-source §2: git+ssh URL pinned at a version tag.
  const canonicalPin =
    /^git\+ssh:\/\/git@github\.com\/tommax-bai\/aidcp-(?:kernel|transport)\.git#v\d+\.\d+\.\d+$/;
  assert.match(root['aidcp-kernel'] ?? '', canonicalPin);
  assert.match(root['aidcp-transport'] ?? '', canonicalPin);
  // The lockfile must have resolved each tag pin down to an exact commit sha.
  const kernelResolvedSha =
    lock.packages['node_modules/aidcp-kernel']?.resolved?.split('#').pop() ?? '';
  const transportResolvedSha =
    lock.packages['node_modules/aidcp-transport']?.resolved?.split('#').pop() ?? '';
  assert.match(kernelResolvedSha, /^[0-9a-f]{40}$/);
  assert.match(transportResolvedSha, /^[0-9a-f]{40}$/);
  // Transport's own kernel requirement must land on the very same commit the root kernel
  // resolved to — same content even when the pin spelling differs (tag vs raw sha).
  const transportKernelRef =
    lock.packages['node_modules/aidcp-transport']?.dependencies?.['aidcp-kernel']
      ?.split('#').pop() ?? '';
  if (/^[0-9a-f]{40}$/.test(transportKernelRef)) {
    assert.equal(transportKernelRef, kernelResolvedSha);
  }
  // Exactly one installed instance of each shared package: if transport's kernel requirement
  // could not dedupe onto the root kernel, npm would nest a divergent copy and this goes red.
  assert.deepEqual(
    Object.keys(lock.packages).filter((key) =>
      /(?:^|\/)node_modules\/aidcp-kernel$/.test(key)),
    ['node_modules/aidcp-kernel'],
  );
  assert.deepEqual(
    Object.keys(lock.packages).filter((key) =>
      /(?:^|\/)node_modules\/aidcp-transport$/.test(key)),
    ['node_modules/aidcp-transport'],
  );
});
