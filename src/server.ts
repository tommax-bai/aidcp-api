import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseDeploymentTarget, type DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import {
  isSyncReadFactPayload,
  type SyncReadPayloadByStream,
} from 'aidcp-kernel/kernel/sync-read-facts.js';
import {
  compareUnsignedSyncReadCursor,
  SyncReadConsumerCheckpointStore,
  type AtomicSyncReadMirror,
  type SyncReadChangedStream,
  type SyncReadJson,
  type SyncReadMirrorHealth,
  type SyncReadProcessReadiness,
  type SyncReadStream,
} from 'aidcp-kernel/kernel/sync-read-snapshot.js';
import type {
  AccountOwnershipAuthorityPort,
  AccountPersonaAuthorityPort,
  AccountRosterAuthorityPort,
  AccountRuntimeAuthorityPort,
  AutomationConfigCommandsPort,
  AutomationPublishLogPort,
  CommentApprovalPolicyPort,
  EdgePublishCommandPort,
  EdgeResumeCommandPort,
  EnvironmentHandshakePort,
  FacebookScopeCommandPort,
  FirstPostProgressPort,
  InteractionApiWritesPort,
  InteractionAuthAuthorityPort,
  NotificationContactsPort,
  OffboardAdmissionLedgerPort,
  PersonaGeneratorAuthorityPort,
  PublishUiUpdateCommandPort,
  ReplyConfigResolverPort,
  StructuredNotificationDeliveryPort,
} from 'aidcp-kernel/kernel/api-direct-port.js';
import type {
  SchemaEnsurer,
  SchemaProber,
  SchemaShape,
} from 'aidcp-kernel/kernel/schema-capability-contract.js';
import type { FacebookGroupOpsPort } from 'aidcp-kernel/kernel/facebook-group-ops-types.js';
import type { PersonaGeneratorPort } from 'aidcp-kernel/kernel/persona-ports.js';
import type {
  PublishApprovalAuthorityPort,
  PublishApprovalDecisionWriterPort,
  PublishDispatchTriggerPort,
} from 'aidcp-kernel/kernel/publish-approval-contract.js';
import { resolveOwnerPgConfig } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';
import { SCHEDULED_AUTOMATION_CATALOG_READER } from 'aidcp-kernel/kernel/scheduled-automation-catalog.js';
import type { ProviderSecretReader } from 'aidcp-kernel/kernel/provider-secret-port.js';
import type {
  RoleModelSelectionReader,
  RoleModelSelectionSource,
} from 'aidcp-kernel/kernel/role-model-selection-port.js';
import {
  normProvider,
  type TextProviderId,
} from 'aidcp-kernel/kernel/text-provider-registry.js';
import {
  EdgeResumeCommandHttpClient,
  FacebookScopeCommandHttpClient,
  PersonaGeneratorCommandHttpClient,
  PublishUiUpdateCommandHttpClient,
  registerAccountOwnershipRoutes,
  registerAccountPersonaRoutes,
  registerAccountRosterRoutes,
  registerAccountRuntimeRoutes,
  registerAutomationConfigCommandsRoutes,
  registerAutomationPublishLogRoutes,
  registerCommentApprovalPolicyRoutes,
  registerEdgePublishCommandRoutes,
  registerEnvironmentHandshakeRoutes,
  registerFirstPostProgressRoutes,
  registerInteractionApiWritesRoutes,
  registerInteractionAuthRoutes,
  registerNotificationContactsRoutes,
  registerOffboardAdmissionLedgerRoutes,
  registerReplyConfigResolverRoutes,
  registerStructuredNotificationRoutes,
} from 'aidcp-transport/transport/api-direct-http.js';
import { FacebookGroupOpsHttpClient } from 'aidcp-transport/transport/facebook-group-ops-http.js';
import {
  InternalHttpClient,
  InternalHttpServer,
} from 'aidcp-transport/transport/internal-http.js';
import {
  registerSyncReadChangedRoute,
  type SyncReadChangedIngress,
} from 'aidcp-transport/transport/sync-read-changed-http.js';
import {
  registerSyncReadSnapshotRoute,
  SyncReadSnapshotHttpClient,
  type SyncReadSnapshotProvider,
} from 'aidcp-transport/transport/sync-read-snapshot-http.js';
import {
  registerPublishApprovalAuthorityRoutes,
} from 'aidcp-transport/transport/publish-approval-authority-http.js';
import {
  registerPublishApprovalDecisionWriterRoutes,
} from 'aidcp-transport/transport/publish-approval-decision-http.js';
import {
  PublishDispatchTriggerHttpClient,
} from 'aidcp-transport/transport/publish-dispatch-trigger-http.js';
import { registerProviderSecretRoutes } from 'aidcp-transport/transport/provider-secret-http.js';
import { registerRoleModelSelectionRoutes } from 'aidcp-transport/transport/role-model-selection-http.js';
import { PgAccountStore } from './account-store.js';
import { AccountStateManager } from './account-state.js';
import { NotificationContactStore } from './cache/notification-contact-store.js';
import {
  ClientUserStore,
  createEnvironmentHandshakeAuthority,
} from './client-auth/client-user-store.js';
import { PgOffboardAdmissionLedger } from './client-auth/offboard-admission-ledger.js';
import { AccountPersonaService } from './config/account-persona-service.js';
import { ApprovalPolicyStore } from './config/approval-policy-store.js';
import {
  ContentScheduleStore,
  createAutomationConfigCommands,
} from './config/content-schedule-store.js';
import { createApiSyncReadConsumerCheckpointStore } from './config/api-sync-read-checkpoint-store.js';
import { ApiSyncReadMirrors } from './config/api-sync-read-mirrors.js';
import { ApiSyncReadSnapshotSource } from './config/api-sync-read-source.js';
import { FacebookCommentConfigStore } from './config/facebook-comment-config-store.js';
import { FacebookOperationPolicyStore } from './config/facebook-operation-policy-store.js';
import { createPersonaPanel } from './config/persona-facade.js';
import { PersonaStore } from './config/persona-store.js';
import { CategoryConfigStore } from './config/category-config-store.js';
import { CredentialStore } from './config/credential-store.js';
import { ModelConfigStore } from './config/model-config-store.js';
import { RoleConfigStore } from './config/role-config-store.js';
import { ROLE_CATALOG, categoryOf, type ThinkingMode } from './config/role-catalog.js';
import type {
  ApiFeishuOwner,
  StartApiFeishuIngressInput,
} from './feishu/api-owner-composition.js';
import type { PublishApprovalPreflightResult } from './feishu/ws-receiver.js';
import { PgInteractionAuthGate } from './interactions/interaction-auth-gate.js';
import { PgInteractionApiWrites } from './interactions/interaction-api-writes.js';
import { ReplyConfigResolver } from './interactions/reply-config-resolver.js';
import { ReplyConfigScopeStore } from './interactions/reply-config-scope-store.js';
import { FirstPostOnboardingStore } from './onboarding/first-post-onboarding-store.js';
import type { PanelDeps } from './panel/types.js';
import { createClientPublishApprovalHandler } from './publish-agent/client-publish-approval.js';
import { createPublishDraftImageRemoveHandler } from './publish-agent/draft-image-remove.js';
import {
  createPublishApprovalAuthorityService,
  createPublishApprovalClient,
  createPublishApprovalDecisionWriter,
  type PublishApprovalClient,
} from './publish-agent/publish-approval-api.js';
import { PublishApprovalOutboxRelay } from './publish-agent/publish-approval-outbox-relay.js';
import {
  createApprovalWriteOutlet,
  type ApprovalWriteOutlet,
} from './publish-agent/publish-approval-outlet.js';
import {
  PUBLISH_APPROVAL_SCHEMA_SQL,
  PublishApprovalStore,
} from './publish-agent/publish-approval-store.js';
import { PublishLogStore } from './publish-agent/publish-log-store.js';
import { createPublishUiUpdateProducer } from './publish-agent/publish-ui-update-producer.js';
import { loadSoulFromYaml } from './soul/loader.js';

const DEFAULT_API_PORT = 8094;
export const API_SYNC_READ_FULL_REFRESH_MS = 30_000;
export const API_SYNC_READ_READINESS_ROUTE =
  'internal/api/sync-read/readiness';

export const API_SYNC_READ_CONSUMED_STREAMS = [
  'session_config_global',
  'edge_presence',
  'publish_in_flight',
  'captcha_availability',
  'automation_config_mirror_health',
] as const satisfies readonly SyncReadStream[];

export const API_SYNC_READ_CHANGED_STREAMS = [
  'edge_presence',
  'publish_in_flight',
  'captcha_availability',
  'automation_config_mirror_health',
] as const satisfies readonly SyncReadChangedStream[];

export const API_SYNC_READ_OWNED_STREAMS = [
  'account_persona',
  'client_environment_automation',
  'automation_account_projection',
  'content_schedule',
  'hot_lead_config',
  'facebook_comment_config',
  'facebook_group_join_automation_config',
] as const satisfies readonly SyncReadStream[];

type ApiConsumedSyncReadStream =
  (typeof API_SYNC_READ_CONSUMED_STREAMS)[number];

/**
 * These DTO surfaces remain Cloud-panel owned after the API process split.
 * The independent API root prepares narrow evidence ports, but does not
 * pretend to own or start a second public panel listener.
 */
export const API_SYNC_READ_PUBLIC_SURFACE_LEDGER = Object.freeze([
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
] as const);

interface ApiDirectAuthorities {
  accountRoster: AccountRosterAuthorityPort;
  accountOwnership: AccountOwnershipAuthorityPort;
  accountRuntime: AccountRuntimeAuthorityPort;
  publishLog: AutomationPublishLogPort;
  edgePublish: EdgePublishCommandPort;
  interactionAuth: InteractionAuthAuthorityPort;
  interactionApiWrites: InteractionApiWritesPort;
  replyConfig: ReplyConfigResolverPort;
  accountPersona: AccountPersonaAuthorityPort;
  environmentHandshake: EnvironmentHandshakePort;
  commentApprovalPolicy: CommentApprovalPolicyPort;
  notificationContacts: NotificationContactsPort;
  firstPostProgress: FirstPostProgressPort;
  automationConfigCommands: AutomationConfigCommandsPort;
  offboardAdmissionLedger: OffboardAdmissionLedgerPort;
  notificationDelivery: StructuredNotificationDeliveryPort;
}

export interface ApiSyncReadRefreshReport {
  readiness: SyncReadProcessReadiness;
  failures: ReadonlyArray<{
    stream: ApiConsumedSyncReadStream;
    message: string;
  }>;
}

export interface ApiSyncReadSnapshotClient {
  fetch<T extends SyncReadJson = SyncReadJson>(
    stream: SyncReadStream,
    validateValue?: (value: unknown) => value is T,
  ): Promise<{
    contractVersion: 1;
    executionTarget: DeploymentTarget;
    factScope: 'shared' | 'target';
    stream: SyncReadStream;
    cursor: string;
    asOf: number;
    freshUntil: number;
    complete: true;
    value: T;
  }>;
}

export interface ApiSyncReadCheckpointPort {
  load(stream: SyncReadStream): ReturnType<SyncReadConsumerCheckpointStore['load']>;
  save(input: unknown): ReturnType<SyncReadConsumerCheckpointStore['save']>;
}

export class ApiSyncReadConsumerRuntime {
  private refreshCycle: Promise<ApiSyncReadRefreshReport> | null = null;
  private readonly streamRefreshes = new Map<
    ApiConsumedSyncReadStream,
    Promise<void>
  >();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly mirrors: ApiSyncReadMirrors,
    private readonly checkpointStore: ApiSyncReadCheckpointPort,
    private readonly snapshotClient: ApiSyncReadSnapshotClient,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  async restore(): Promise<void> {
    for (const stream of API_SYNC_READ_CONSUMED_STREAMS) {
      try {
        const loaded = await this.checkpointStore.load(stream);
        if (loaded.outcome === 'loaded') {
          const restored = mirrorFor(this.mirrors, stream).restoreCheckpoint(
            loaded.checkpoint,
          );
          if (restored.outcome === 'unknown') {
            mirrorFor(this.mirrors, stream).beginRecovery(restored.message);
          }
          continue;
        }
        if (loaded.outcome === 'unknown') {
          mirrorFor(this.mirrors, stream).beginRecovery(loaded.message);
        }
      } catch (error) {
        mirrorFor(this.mirrors, stream).beginRecovery(
          `checkpoint_restore_failed:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async refreshStream(
    stream: ApiConsumedSyncReadStream,
    minimumGeneration?: string,
  ): Promise<void> {
    const active = this.streamRefreshes.get(stream);
    if (active) {
      return minimumGeneration
        ? active.then(() => this.refreshStream(stream, minimumGeneration))
        : active;
    }
    const refresh = this.performRefresh(stream, minimumGeneration).finally(() => {
      if (this.streamRefreshes.get(stream) === refresh) {
        this.streamRefreshes.delete(stream);
      }
    });
    this.streamRefreshes.set(stream, refresh);
    return refresh;
  }

  /**
   * A sync_read.changed delivery may call refreshStream for acceleration.
   * The periodic full cycle below remains authoritative and uses the same
   * per-stream serialization, so a missed wakeup cannot strand a delta.
   */
  private async performRefresh(
    stream: ApiConsumedSyncReadStream,
    minimumGeneration?: string,
  ): Promise<void> {
    const mirror = mirrorFor(this.mirrors, stream);
    try {
      const envelope = await this.snapshotClient.fetch(
        stream,
        (value): value is SyncReadPayloadByStream[typeof stream] =>
          isSyncReadFactPayload(stream, value),
      );
      if (
        minimumGeneration
        && compareUnsignedSyncReadCursor(
          envelope.cursor,
          minimumGeneration,
        ) < 0
      ) {
        throw new Error(
          `sync_read_snapshot_generation_behind stream=${stream} `
            + `expected>=${minimumGeneration} actual=${envelope.cursor}`,
        );
      }
      const applied = this.mirrors.apply(envelope, 'owner_fetch');
      if (applied.outcome === 'rejected') {
        throw new Error(
          `sync_read_apply_failed stream=${stream} reason=${applied.reason}`,
        );
      }
      if (applied.outcome === 'already_applied') return;
      const saved = await this.checkpointStore.save(mirror.checkpoint());
      if (saved.outcome === 'rejected') {
        throw new Error(
          `sync_read_checkpoint_save_failed stream=${stream} reason=${saved.reason}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mirror.beginRecovery(message);
      throw error;
    }
  }

  refreshAll(): Promise<ApiSyncReadRefreshReport> {
    if (this.refreshCycle) return this.refreshCycle;
    const cycle = (async (): Promise<ApiSyncReadRefreshReport> => {
      const settled = await Promise.allSettled(
        API_SYNC_READ_CONSUMED_STREAMS.map((stream) =>
          this.refreshStream(stream),
        ),
      );
      const failures = settled.flatMap((result, index) => {
        if (result.status === 'fulfilled') return [];
        return [{
          stream: API_SYNC_READ_CONSUMED_STREAMS[index]!,
          message:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        }];
      });
      return { readiness: this.readiness(), failures };
    })();
    this.refreshCycle = cycle.finally(() => {
      this.refreshCycle = null;
    });
    return this.refreshCycle;
  }

  async bootstrap(): Promise<ApiSyncReadRefreshReport> {
    await this.restore();
    return this.refreshAll();
  }

  startPeriodic(
    onCycle?: (report: ApiSyncReadRefreshReport) => void | Promise<void>,
    intervalMs = API_SYNC_READ_FULL_REFRESH_MS,
  ): void {
    if (
      !Number.isInteger(intervalMs)
      || intervalMs <= 0
      || intervalMs > API_SYNC_READ_FULL_REFRESH_MS
    ) {
      throw new Error(
        `API sync-read refresh interval must be an integer in 1..${API_SYNC_READ_FULL_REFRESH_MS}`,
      );
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refreshAll()
        .then((report) => onCycle?.(report))
        .catch((error) => {
          this.logger.warn(
            `[aidcp-api] sync-read periodic refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  readiness(): SyncReadProcessReadiness {
    return this.mirrors.readiness();
  }

  health(): {
    readiness: SyncReadProcessReadiness;
    streams: readonly SyncReadMirrorHealth[];
  } {
    return {
      readiness: this.readiness(),
      streams: API_SYNC_READ_CONSUMED_STREAMS.map((stream) =>
        mirrorFor(this.mirrors, stream).health(),
      ),
    };
  }
}

function mirrorFor(
  mirrors: ApiSyncReadMirrors,
  stream: ApiConsumedSyncReadStream,
): AtomicSyncReadMirror<SyncReadJson> {
  switch (stream) {
    case 'session_config_global':
      return mirrors.sessionConfig;
    case 'edge_presence':
      return mirrors.edgePresence;
    case 'publish_in_flight':
      return mirrors.publishInFlight;
    case 'captcha_availability':
      return mirrors.captchaAvailability;
    case 'automation_config_mirror_health':
      return mirrors.automationHealth;
  }
}

export function createApiSyncReadPanelEvidencePorts(
  mirrors: ApiSyncReadMirrors,
): Pick<
  PanelDeps,
  | 'edgePresenceEvidence'
  | 'publishInFlightEvidence'
  | 'configMirrorServicesHealth'
> {
  return {
    edgePresenceEvidence: () => {
      const evidence = mirrors.presence();
      return {
        state: evidence.state,
        asOf: evidence.asOf,
        onlineEdgeCount: evidence.onlineEdgeCount,
      };
    },
    publishInFlightEvidence: () => mirrors.inFlightEvidence(),
    configMirrorServicesHealth: () => {
      const api = mirrors.sessionConfig.health();
      const automation = mirrors.automationConfigMirrorHealth();
      const apiEntry =
        api.deliveryState === 'fresh'
          ? [{
              mirrorKey: 'session_config_global',
              tier: 'parameter' as const,
              version: safeCursorNumber(api.appliedCursor),
              lastComparedAt: api.lastObservedAt,
              lastReloadedAt: api.lastAppliedAt,
              reloadFailingSince: null,
              state: 'fresh' as const,
              staleMs: null,
              observeStaleMs:
                api.sourceAsOf === null || api.freshUntil === null
                  ? 0
                  : Math.max(0, api.freshUntil - api.sourceAsOf),
              haltsOnStale: false,
              staleForMs: 0,
            }]
          : [];
      return {
        services: [
          {
            sourceService: 'api',
            asOf: api.sourceAsOf,
            deliveryState: api.deliveryState,
            entries: apiEntry,
          },
          {
            ...automation,
            entries: automation.entries.map((entry) => ({ ...entry })),
          },
        ],
      };
    },
  };
}

function safeCursorNumber(cursor: string | null): number | null {
  if (!cursor) return null;
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface ApiCompositionRoot {
  target: DeploymentTarget;
  pool: pg.Pool;
  authorities: ApiDirectAuthorities;
  apiFeishu: ApiFeishuOwner;
  panelFacebookGroupTargets: NonNullable<PanelDeps['facebookGroupTargets']>;
  publishApproval: {
    authority: PublishApprovalAuthorityPort;
    decisionWriter: PublishApprovalDecisionWriterPort;
    outboxRelay: PublishApprovalOutboxRelay;
  };
  pairedCommands: {
    edgeResume: EdgeResumeCommandPort;
    facebookScope: FacebookScopeCommandPort;
    publishUi: PublishUiUpdateCommandPort;
    personaGenerator: PersonaGeneratorAuthorityPort;
  };
  syncRead: {
    ownerSource: ApiSyncReadSnapshotSource;
    consumer: ApiSyncReadConsumerRuntime;
    panelEvidence: ReturnType<typeof createApiSyncReadPanelEvidencePorts>;
  };
  /**
   * content 进程经内部 HTTP 取的两条窄读口，事实源（三张模型配置表 + 凭据表）都在本域。
   * **两条都 MUST 无条件注册**：对端拿不到时的表现不是报错，而是被调用点吞成「本来就没配」
   * 然后静默回落 env —— 一条链路悄悄不工作、零信号。
   */
  contentReads: {
    roleModelSelectionSource: RoleModelSelectionSource;
    providerSecretReader: ProviderSecretReader;
  };
  business: {
    startIngress(): Promise<void>;
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || /\s/.test(value)) {
    throw new Error(`${name} is required and must not contain whitespace`);
  }
  return value;
}

function requiredUrl(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function apiPort(): number {
  const raw = process.env.AIDCP_API_PORT?.trim();
  if (!raw) return DEFAULT_API_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('AIDCP_API_PORT must be an integer in 1..65535');
  }
  return port;
}

function deploymentTarget(): DeploymentTarget {
  const target = parseDeploymentTarget(process.env.AIDCP_DEPLOY_ENV);
  if (!target) throw new Error('AIDCP_DEPLOY_ENV must be dev or ol');
  return target;
}

function requiredSchemaObjects(ddl: readonly string[]): {
  tables: Map<string, Set<string>>;
  indexes: Set<string>;
} {
  const tables = new Map<string, Set<string>>();
  const indexes = new Set<string>();
  const ensureTable = (table: string): Set<string> => {
    const current = tables.get(table) ?? new Set<string>();
    tables.set(table, current);
    return current;
  };
  for (const statement of ddl) {
    for (const match of statement.matchAll(
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\);/gi,
    )) {
      const columns = ensureTable(match[1]);
      for (const line of match[2].split('\n')) {
        const column = /^\s*([a-z_][a-z0-9_]*)\s+/i.exec(line)?.[1];
        if (
          column
          && !['primary', 'unique', 'constraint', 'check', 'foreign'].includes(
            column.toLowerCase(),
          )
        ) {
          columns.add(column);
        }
      }
    }
    for (const match of statement.matchAll(
      /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      ensureTable(match[1]).add(match[2]);
    }
    for (const match of statement.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      indexes.add(match[1]);
    }
  }
  return { tables, indexes };
}

/**
 * API stores remain migration-owned: inspect catalog truth and fail startup
 * when a required object is absent, but never execute historical DDL at runtime.
 */
const migrationManagedSchema: SchemaEnsurer = async (client, spec) => {
  const required = requiredSchemaObjects(spec.ddl);
  const tableNames = [...required.tables.keys()];
  const [columnRows, indexRows] = await Promise.all([
    client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])`,
      [tableNames],
    ),
    client.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = ANY($1::text[])`,
      [[...required.indexes]],
    ),
  ]);
  const actualColumns = new Set(
    columnRows.rows
      .map((row) =>
        typeof row.table_name === 'string' && typeof row.column_name === 'string'
          ? `${row.table_name}.${row.column_name}`
          : null,
      )
      .filter((value): value is string => value !== null),
  );
  const actualIndexes = new Set(
    indexRows.rows
      .map((row) => row.indexname)
      .filter((value): value is string => typeof value === 'string'),
  );
  const missing: string[] = [];
  for (const [table, columns] of required.tables) {
    if (![...actualColumns].some((value) => value.startsWith(`${table}.`))) {
      missing.push(`table:${table}`);
      continue;
    }
    for (const column of columns) {
      if (!actualColumns.has(`${table}.${column}`)) {
        missing.push(`column:${table}.${column}`);
      }
    }
  }
  for (const index of required.indexes) {
    if (!actualIndexes.has(index)) missing.push(`index:${index}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `schema_${spec.capability}_incomplete since=${spec.sinceVersion} missing=${missing.join(',')}`,
    );
  }
  return 'ready';
};

const probeSchemaShape: SchemaProber = async (client, tables): Promise<SchemaShape> => {
  const result = await client.query(
    `SELECT candidate AS relname
       FROM unnest($1::text[]) AS candidate
      WHERE to_regclass(candidate) IS NOT NULL`,
    [tables],
  );
  return {
    tables: new Set(
      result.rows
        .map((row) => row.relname)
        .filter((name): name is string => typeof name === 'string'),
    ),
    columns: new Set(),
    indexes: new Set(),
  };
};

function personaGeneratorFromCommand(
  command: PersonaGeneratorAuthorityPort,
): PersonaGeneratorPort {
  return {
    async generate(input) {
      const idempotencyKey = input.diversitySeed?.trim();
      if (!idempotencyKey) throw new Error('persona_generation_idempotency_key_missing');
      const receipt = await command.generate({ ...input, idempotencyKey });
      if (receipt.outcome === 'collision') {
        throw new Error('persona_generation_idempotency_collision');
      }
      return receipt.result;
    },
  };
}

export function createApiPanelFacebookGroupTargets(
  reads: FacebookGroupOpsPort,
  commands: FacebookScopeCommandPort,
  commandId: () => string = randomUUID,
): NonNullable<PanelDeps['facebookGroupTargets']> {
  return {
    async importTargets(inputs, importBatch, options) {
      const receipt = await commands.importTargets({
        commandId: commandId(),
        inputs,
        importBatch,
        ...(options ? { options } : {}),
      });
      if (receipt.outcome === 'collision') {
        throw new Error('facebook_scope_command_collision');
      }
      return receipt.result;
    },
    listTargets: (options) => reads.listTargets(options),
    listFacets: () => reads.listFacets(),
    listRegionCommentTemplates: () => reads.listRegionCommentTemplates(),
    setRegionCommentTemplates: (region, commentTemplates, updatedBy) =>
      reads.setRegionCommentTemplates(region, commentTemplates, updatedBy),
    setEnabled: (groupUrl, enabled) => reads.setEnabled(groupUrl, enabled),
    async replaceTargetScopes(groupUrls, accountGroupLabels, updatedBy) {
      const receipt = await commands.replaceTargetScopes({
        commandId: commandId(),
        groupUrls,
        accountGroupLabels,
        updatedBy,
      });
      if (receipt.outcome === 'collision') {
        throw new Error('facebook_scope_command_collision');
      }
      return receipt.result;
    },
    accountProgress: () => reads.accountProgress(),
    listAssignments: (limit) => reads.listAssignments(limit),
    reclaimStaleAssignments: (ttlMs) => reads.reclaimStaleAssignments(ttlMs),
  };
}

export function createApiPublishLogAuthority(
  owner: AutomationPublishLogPort,
  publishUi: Pick<
    ReturnType<typeof createPublishUiUpdateProducer>,
    'pushPreview' | 'pushState'
  >,
  logger: Pick<Console, 'warn'> = console,
): AutomationPublishLogPort {
  return {
    loadForDispatch: (recordId) => owner.loadForDispatch(recordId),
    updateStatus: (recordId, status) => owner.updateStatus(recordId, status),
    updatePostId: (recordId, postId, postUrl) =>
      owner.updatePostId(recordId, postId, postUrl),
    markScheduled: (recordId, scheduledAt, scheduledPlatformId) =>
      owner.markScheduled(recordId, scheduledAt, scheduledPlatformId),
    markImagesAttached: (recordId, imageCount) =>
      owner.markImagesAttached(recordId, imageCount),
    listDueScheduled: (limit, now) => owner.listDueScheduled(limit, now),
    deferScheduledReconcile: (recordId, error, nextAt, maxAttempts) =>
      owner.deferScheduledReconcile(recordId, error, nextAt, maxAttempts),
    confirmScheduledPublished: (recordId, postId, postUrl) =>
      owner.confirmScheduledPublished(recordId, postId, postUrl),
    getMostRecentPublishTime: () => owner.getMostRecentPublishTime(),
    recentPublishedContents: (limit) => owner.recentPublishedContents(limit),
    editDraft: async (recordId, expectedVersion, patch, editor, expectedAccountId) => {
      const result = await owner.editDraft(
        recordId,
        expectedVersion,
        patch,
        editor,
        expectedAccountId,
      );
      if (result.ok) {
        void publishUi.pushPreview(recordId).catch((error) => {
          logger.warn(
            `[aidcp-api] draft committed; UI preview delivery failed record=${recordId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
      return result;
    },
    rejectPendingApproval: async (recordId) => {
      const draft = await owner.loadForDispatch(recordId);
      const rejected = await owner.rejectPendingApproval(recordId);
      if (rejected && draft) {
        void publishUi
          .pushState(
            draft.accountId,
            recordId,
            'rejected',
            draft.contentVersion,
            draft.title,
          )
          .catch((error) => {
            logger.warn(
              `[aidcp-api] rejection committed; UI state delivery failed record=${recordId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
      return rejected;
    },
    pendingApprovalForAccount: (accountId) => owner.pendingApprovalForAccount(accountId),
    pendingPublishPreviewForAccount: (accountId) =>
      owner.pendingPublishPreviewForAccount(accountId),
    lastPublishedForAccount: (accountId) => owner.lastPublishedForAccount(accountId),
    countPendingForAccount: (accountId) => owner.countPendingForAccount(accountId),
    countPendingAutonomousForAccount: (accountId) =>
      owner.countPendingAutonomousForAccount(accountId),
    countPublishedTodayForAccount: (accountId) =>
      owner.countPublishedTodayForAccount(accountId),
    countPublishedSinceForAccount: (accountId, since) =>
      owner.countPublishedSinceForAccount(accountId, since),
  };
}

interface ApiPublishOwnerHandlerDeps {
  publishLog: Pick<
    AutomationPublishLogPort,
    'loadForDispatch' | 'editDraft' | 'rejectPendingApproval'
  >;
  approvalClient: Pick<PublishApprovalClient, 'readApproval'>;
  writeApprovalDecision: ApprovalWriteOutlet;
  triggerApproved(
    requestId: string,
    revision: number,
    kind: 'human_reconfirm',
  ): Promise<void>;
  logger?: Pick<Console, 'warn'>;
}

export function createApiPublishOwnerHandlers(
  deps: ApiPublishOwnerHandlerDeps,
): {
  edgePublish: EdgePublishCommandPort;
  feishuApprovalIngress: Omit<
    StartApiFeishuIngressInput,
    'commandFace' | 'delegatedTasks'
  >;
} {
  const logger = deps.logger ?? console;
  const readLiveContentVersion = async (recordId: number): Promise<number | null> => {
    const draft = await deps.publishLog.loadForDispatch(recordId);
    return draft?.contentVersion ?? null;
  };
  const preflightApprovePublish = async (
    requestId: string,
  ): Promise<PublishApprovalPreflightResult> => {
    const match = /^publish-(\d+)$/.exec(requestId);
    if (!match) return { ok: true };
    const draft = await deps.publishLog.loadForDispatch(Number(match[1]));
    return draft
      ? { ok: true, accountId: draft.accountId }
      : { ok: false, reason: 'publish_target_unavailable' };
  };
  const triggerApproved = (trigger: {
    requestId: string;
    revision: number;
    kind: 'human_reconfirm';
  }): void => {
    void deps
      .triggerApproved(trigger.requestId, trigger.revision, trigger.kind)
      .catch((error) => {
        logger.warn(
          `[aidcp-api] human_reconfirm trigger failed requestId=${trigger.requestId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };
  const notifyRejected = (requestId: string): void => {
    const match = /^publish-(\d+)$/.exec(requestId);
    if (!match) return;
    void deps.publishLog.rejectPendingApproval(Number(match[1])).catch((error) => {
      logger.warn(
        `[aidcp-api] publish rejection materialization failed requestId=${requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };

  const removeDraftImage = createPublishDraftImageRemoveHandler({
    loadDraft: (recordId) => deps.publishLog.loadForDispatch(recordId),
    readApproval: (requestId) => deps.approvalClient.readApproval(requestId),
    editDraft: (recordId, expectedVersion, patch, editor) =>
      deps.publishLog.editDraft(recordId, expectedVersion, patch, editor),
    readLiveVersion: readLiveContentVersion,
    // The injected publish-log authority owns the one-way preview producer for
    // every successful owner mutation. The handler must not emit a second copy.
    refreshPreview: () => {},
    logger,
  });
  const decidePublishApproval = createClientPublishApprovalHandler({
    loadDraft: (recordId) => deps.publishLog.loadForDispatch(recordId),
    readApproval: (requestId) => deps.approvalClient.readApproval(requestId),
    editDraft: (recordId, expectedVersion, patch, editor) =>
      deps.publishLog.editDraft(recordId, expectedVersion, patch, editor),
    preflight: preflightApprovePublish,
    writeApproval: (requestId, approved, payload, decidedBy) =>
      deps.writeApprovalDecision(requestId, approved, payload, {
        decidedBy: `client:${decidedBy}`,
        decidedVia: 'client',
      }),
    triggerApproved,
    notifyRejected,
    readDispatchState: async (requestId) => {
      const row = await deps.approvalClient.readApproval(requestId);
      if (!row || !row.approved) return null;
      if (row.dispatchState === 'dispatching') {
        return { dispatchState: 'dispatching' as const };
      }
      if (row.dispatchState !== 'pending_dispatch') return null;
      return row.dispatchBlockedReason
        ? {
            dispatchState: 'blocked' as const,
            dispatchBlockedReason: row.dispatchBlockedReason,
          }
        : { dispatchState: 'pending_dispatch' as const };
    },
    logger,
  });

  return {
    edgePublish: {
      removeDraftImage: (input) => removeDraftImage(input.payload, input.session),
      decidePublishApproval: (input) =>
        decidePublishApproval(input.payload, input.accountId),
    },
    feishuApprovalIngress: {
      writeApproval: (requestId, approved, payload, context) =>
        deps.writeApprovalDecision(requestId, approved, payload, context),
      onApproved: triggerApproved,
      onRejected: notifyRejected,
      readLiveContentVersion,
      preflightApprovePublish,
    },
  };
}

async function buildApiCompositionRoot(): Promise<ApiCompositionRoot> {
  const mode = process.env.AIDCP_SERVICE?.trim();
  if (mode && mode !== 'api') {
    throw new Error(`aidcp-api only accepts AIDCP_SERVICE=api, received ${mode}`);
  }
  const target = deploymentTarget();
  const pool = new pg.Pool({ ...resolveOwnerPgConfig('api'), max: 30 });
  const automationHttp = new InternalHttpClient(requiredUrl('AIDCP_AUTOMATION_URL'));
  const contentHttp = new InternalHttpClient(requiredUrl('AIDCP_CONTENT_URL'));
  const automationToken = requiredEnv('AIDCP_AUTOMATION_INTERNAL_TOKEN');
  const contentToken = requiredEnv('AIDCP_CONTENT_INTERNAL_TOKEN');
  const publishApprovalToken = requiredEnv('AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN');

  const accountStore = new PgAccountStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
  });
  const publishLogStore = new PublishLogStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
    schemaProber: probeSchemaShape,
  });
  const clientUserStore = new ClientUserStore({
    pool,
    executionTarget: target,
    schemaEnsurer: migrationManagedSchema,
  });
  const approvalPolicy = new ApprovalPolicyStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
  });
  const notificationContacts = new NotificationContactStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
  });
  const firstPostProgress = new FirstPostOnboardingStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
  });
  const contentSchedule = new ContentScheduleStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
    scheduledAutomationCatalog: SCHEDULED_AUTOMATION_CATALOG_READER,
  });
  const facebookCommentConfig = new FacebookCommentConfigStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
  });
  const personaStore = new PersonaStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
  });
  /**
   * Facebook 运营基线（change split-cloud-automation-production-runtime 批 E-2 步骤 2）。
   *
   * 构造它**不是为了本进程自己用**，而是为了发得出同步读流 `facebook_operation_policy` ——
   * 自动化进程的 Facebook 浏览模式整个挂在这条流上，发不出来那边就是「账号永远不开始浏览」。
   * 与上面模型配置三件套同形（构造只为答别的进程），判据见批 A 的清单：**看结果有没有去处，
   * 不是看去处在不在本进程**。
   *
   * **不传 mirrorVersionBumper**：本进程今天只读这几张表、写口还在单体里；
   * 将来把策略写口搬进本 main 时 MUST 同时补 bumper，否则跨进程失效通道会静默断掉
   * ——自动化侧的基线副本再也不会刷新，而两边都不报错。
   */
  const facebookOperationPolicy = new FacebookOperationPolicyStore({
    pool,
    schemaProber: probeSchemaShape,
    executionTarget: target,
  });
  const replyScopes = new ReplyConfigScopeStore({ pool });
  const publishApprovalStore = new PublishApprovalStore({
    pool,
    executionTarget: target,
  });
  // 模型配置三张表 + 加密凭据表（change split-cloud-automation-production-runtime，A-3）。
  // 全是本域属主表；构造它们**不是**为了本进程自己用，而是为了把两条窄口喂给 content 进程
  // ——单体在 startContentReadApi 里注册这两条 route，本手写 main 一直漏注册，
  // 结果 content 侧的库内密钥读必失败、且被调用点吞成「本来就没配」（见 contentReads 那一段）。
  // **不传 mirrorVersionBumper**：本进程只读这三张表、不经它们写；缺省语义即「不推版本」。
  // 将来若把面板配置写口也搬进本 main，MUST 同时补上 bumper，否则跨进程失效通道会静默断掉。
  const modelConfigStore = new ModelConfigStore({ pool, schemaEnsurer: migrationManagedSchema });
  const roleConfigStore = new RoleConfigStore({ pool, schemaEnsurer: migrationManagedSchema });
  const categoryConfigStore = new CategoryConfigStore({ pool, schemaEnsurer: migrationManagedSchema });
  const credentialStore = new CredentialStore({ pool, schemaEnsurer: migrationManagedSchema });

  await Promise.all([
    accountStore.init(),
    publishLogStore.init(),
    clientUserStore.init(),
    approvalPolicy.init(),
    notificationContacts.init(),
    firstPostProgress.init(),
    contentSchedule.init(),
    facebookCommentConfig.init(),
    facebookOperationPolicy.init(),
    personaStore.init(),
    replyScopes.init(),
    modelConfigStore.init(),
    roleConfigStore.init(),
    categoryConfigStore.init(),
    credentialStore.init(),
    migrationManagedSchema(pool, {
      capability: 'publish_approval',
      sinceVersion: '0063_publish_approval_decision',
      ddl: [PUBLISH_APPROVAL_SCHEMA_SQL],
    }),
  ]);
  const accountState = new AccountStateManager(accountStore);
  await accountState.init();

  // ── content 进程要用、事实源在本域的两条窄口 ──────────────────────────────────────────
  // 解析逻辑**只此一份**：四层回落（per-role → 分类 → 全局 → 代码默认）在属主侧算完再送快照，
  // 绝不把三张表送过去让调用方复刻——复刻正是「两侧各写一份、各自编译通过、只有真跑才发现不一致」。
  // 与单体 segA 里那份逐字同源。
  const resolveSelection = (role?: string): { provider: TextProviderId; model: string } => {
    if (role) {
      const ro = roleConfigStore.getForRole(role);
      if (ro.model?.trim()) return { provider: normProvider(ro.provider), model: ro.model.trim() };
      const catId = categoryOf(role);
      if (catId) {
        const cat = categoryConfigStore.getForCategory(catId);
        if (cat.model?.trim()) return { provider: normProvider(cat.provider), model: cat.model.trim() };
      }
    }
    const g = modelConfigStore.getCached();
    return { provider: normProvider(g.textProvider), model: g.textModel };
  };
  // 温度只两层（无分类层）；思考模式两层、无全局层。与单体同。
  const resolveTempForRole = (role?: string): number | undefined =>
    (role ? roleConfigStore.getForRole(role).temperature : null) ?? undefined;
  const resolveThinkingForRole = (role?: string): ThinkingMode | undefined => {
    if (!role) return undefined;
    const ro = roleConfigStore.getForRole(role).thinkingMode;
    if (ro) return ro;
    const catId = categoryOf(role);
    if (catId) {
      const cat = categoryConfigStore.getForCategory(catId).thinkingMode;
      if (cat) return cat;
    }
    return undefined;
  };
  const roleModelSelection: RoleModelSelectionReader = {
    forRole: (role) => {
      const sel = resolveSelection(role);
      const temperature = resolveTempForRole(role);
      const thinkingMode = resolveThinkingForRole(role);
      return {
        provider: sel.provider,
        model: sel.model,
        ...(temperature === undefined ? {} : { temperature }),
        ...(thinkingMode === undefined ? {} : { thinkingMode }),
      };
    },
  };
  const contentReads = {
    // 取源：把**全部已登记角色**逐个预解析成快照。未登记角色查不到 ⇒ 调用方用 fallback（即全局那一层），
    // 与单体逐字一致（那种角色本来就穿过前两层落到全局）。
    roleModelSelectionSource: {
      fetchRoleModelSelections: async () => ({
        fallback: roleModelSelection.forRole(),
        byRole: Object.fromEntries(
          ROLE_CATALOG.map((r) => [r.roleId, roleModelSelection.forRole(r.roleId)]),
        ),
      }),
    } satisfies RoleModelSelectionSource,
    // 厂商密钥：只在对端启动期被调几次、不在热路径 ⇒ 普通异步跨进程读即可，不需要镜像。
    providerSecretReader: {
      getSecretForRuntime: (provider, field) => credentialStore.getSecretForRuntime(provider, field),
    } satisfies ProviderSecretReader,
  };

  const pairedCommands = {
    edgeResume: new EdgeResumeCommandHttpClient(automationHttp, automationToken, target),
    facebookScope: new FacebookScopeCommandHttpClient(automationHttp, automationToken, target),
    publishUi: new PublishUiUpdateCommandHttpClient(automationHttp, automationToken, target),
    personaGenerator: new PersonaGeneratorCommandHttpClient(contentHttp, contentToken, target),
  };

  const personaPanel = createPersonaPanel({ store: personaStore });
  const accountPersona = new AccountPersonaService({
    generator: personaGeneratorFromCommand(pairedCommands.personaGenerator),
    facade: personaPanel,
    personaBinding: (accountId) => personaStore.bindingFor(accountId),
    logger: console,
  });
  const publishUi = createPublishUiUpdateProducer({
    loadPreview: (recordId) => publishLogStore.pendingPublishPreviewForRecord(recordId),
    command: pairedCommands.publishUi,
  });

  const publishLog = createApiPublishLogAuthority(
    publishLogStore,
    publishUi,
    console,
  );

  const publishApprovalAuthority = createPublishApprovalAuthorityService(
    publishApprovalStore,
    target,
  );
  const publishApprovalClient = createPublishApprovalClient(
    publishApprovalAuthority,
    target,
  );
  const publishDispatchTrigger: PublishDispatchTriggerPort =
    new PublishDispatchTriggerHttpClient(automationHttp, publishApprovalToken);
  const publishApprovalOutboxRelay = new PublishApprovalOutboxRelay({
    executionTarget: target,
    store: publishApprovalStore,
    trigger: publishDispatchTrigger,
    logger: console,
  });
  const approvalWriteOutlet = createApprovalWriteOutlet({
    store: publishApprovalStore,
    resolveEnvKey: async ({ subjectKind, candidateRef }) => {
      if (subjectKind !== 'publish') return null;
      const recordId = Number(candidateRef);
      if (!Number.isInteger(recordId) || recordId <= 0) return null;
      const draft = await publishLogStore.loadForDispatch(recordId);
      return draft ? clientUserStore.envKeyForAccount(draft.accountId) : null;
    },
    logger: console,
  });
  const writeApprovalDecision: ApprovalWriteOutlet = async (
    requestId,
    approved,
    payload,
    context,
  ) => {
    const result = await approvalWriteOutlet(
      requestId,
      approved,
      payload,
      context,
    );
    if (approved && result.written) {
      void publishApprovalOutboxRelay.runOnce(20).catch((error) => {
        console.warn(
          `[aidcp-api] PublishApproved outbox wake failed requestId=${requestId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    return result;
  };
  const publishApprovalDecisionWriter = createPublishApprovalDecisionWriter(
    writeApprovalDecision,
    target,
  );
  const publishOwnerHandlers = createApiPublishOwnerHandlers({
    publishLog,
    approvalClient: publishApprovalClient,
    writeApprovalDecision,
    triggerApproved: async (requestId, revision, kind) => {
      await publishDispatchTrigger.triggerApproved({
        requestId,
        revision,
        executionTarget: target,
        kind,
      });
    },
    logger: console,
  });
  const edgePublish = publishOwnerHandlers.edgePublish;

  const panelFacebookGroupTargets = createApiPanelFacebookGroupTargets(
    new FacebookGroupOpsHttpClient(automationHttp),
    pairedCommands.facebookScope,
  );

  const { createApiFeishuOwner } = await import('./feishu/api-owner-composition.js');
  const apiFeishu = createApiFeishuOwner({
    pool,
    accountStore,
    accountDisplayName: (accountId) => accountStore.getDisplayName(accountId).name,
    publishApprovalDecisionWriter,
    deploymentTarget: target,
    fallbackChatId: process.env.FEISHU_CHAT_ID,
    logger: console,
  });
  const managementChatIds = new Set(
    (process.env.FEISHU_MANAGEMENT_CHAT_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const commandFace = apiFeishu.createCommandFace({
    account: {
      async requireCommandAccount(accountId) {
        if (accountId?.trim()) return accountId.trim();
        const rows = await accountStore.listAccountIdentities();
        if (rows.length !== 1) {
          throw new Error(`command_account_ambiguous:${rows.length}`);
        }
        return rows[0].accountId;
      },
      getStatus: (accountId) => accountState.getStatus(accountId),
      pause: (accountId) => accountState.pause(accountId),
      resume: (accountId) => accountState.resume(accountId),
      async resumeEdgesForAccount(accountId) {
        const receipt = await pairedCommands.edgeResume.resumeEdgesForAccount({
          commandId: `api-feishu-resume:${accountId}:${randomUUID()}`,
          accountId,
        });
        if (receipt.outcome === 'collision') {
          return { state: 'unknown', reason: 'edge_resume_command_collision' };
        }
        return { state: 'applied', resumedEdges: receipt.resumedEdges };
      },
    },
    bindChat: (record) => apiFeishu.botChatStore.setDefault(record),
    delegate: async () => {
      throw new Error('automation_operator_command_unavailable:delegate');
    },
    publish: async () => {
      throw new Error('automation_operator_command_unavailable:publish');
    },
    comment: async () => {
      throw new Error('automation_operator_command_unavailable:comment');
    },
    dispatch: async () => {
      throw new Error('automation_operator_command_unavailable:dispatch');
    },
    // **刻意不传**（cloud task 1.3a；交接文档 §4.1 早就点名了这一处）。
    // 这里原本写的是 `() => false`——把「读不到调度引擎」答成「调度引擎正常停着」。
    // 面板上 false 的含义是后者，运营看到它什么都不会做，而真相是这个进程根本没接那条通道。
    // 字段是可选的（1.4a 把它改可选，正是为了让「诚实地缺席」在类型层表达得出来），
    // 省略即回 null + 具名 `not_wired`。**MUST NOT 为了把结构填满再补一个假值。**
    // 要在这里读到真状态，得照 cloud 组装根那样建一个指向 automation 的客户端。
    managementChatIds,
    logger: console,
  });
  let businessIngressStarted = false;
  const startBusinessIngress = async (): Promise<void> => {
    if (businessIngressStarted) return;
    await apiFeishu.startIngress({
      commandFace,
      ...publishOwnerHandlers.feishuApprovalIngress,
    });
    businessIngressStarted = true;
  };

  const syncReadOwnerSource = new ApiSyncReadSnapshotSource({
    executionTarget: target,
    pool,
    parseSoul: (personaText) =>
      JSON.parse(JSON.stringify(loadSoulFromYaml(personaText))) as SyncReadJson,
    // 发布前**先按库回读**：本进程的内存镜像可能落后于已经推进的版本游标，
    // 那会发出「新游标 + 旧基线」，消费方存下就再也不会重取（游标没变就不拉）。
    // 合成规则只在属主存储里有一份，这里 MUST NOT 用 SQL 另算一遍。
    //
    // 逐环境基线与全局慢启动曲线**在同一次刷新之后一起取**：分两次取会多出
    // 「基线取自刷新后、曲线取自刷新前」这种错配，且两边都不报错。
    facebookOperationPolicy: async () => {
      await facebookOperationPolicy.refreshFromAuthority();
      return {
        environments: facebookOperationPolicy.baselineProjections(),
        slowStart: facebookOperationPolicy.slowStartRuntimePolicy(),
      };
    },
  });
  const syncReadMirrors = new ApiSyncReadMirrors(target);
  const syncReadConsumer = new ApiSyncReadConsumerRuntime(
    syncReadMirrors,
    createApiSyncReadConsumerCheckpointStore(pool, target),
    new SyncReadSnapshotHttpClient(automationHttp, {
      executionTarget: target,
      bearerToken: automationToken,
    }),
    console,
  );

  const authorities: ApiDirectAuthorities = {
    accountRoster: {
      listAccountIdentities: () => accountStore.listAccountIdentities(),
    },
    accountOwnership: {
      getExecutionTarget: (accountId) => accountStore.getExecutionTarget(accountId),
      resolveExecutionTarget: (accountId) => accountStore.resolveExecutionTarget(accountId),
      setExecutionTarget: (accountId, nextTarget) =>
        accountStore.setExecutionTarget(accountId, nextTarget),
    },
    accountRuntime: {
      ensureAccount: (accountId, platform) => accountStore.ensureAccount(accountId, platform),
      getPlatformOrNull: (accountId) => accountStore.getPlatformOrNull(accountId),
      getContactInfo: (accountId) => accountStore.getContactInfo(accountId),
      recordNickname: (accountId, nickname) => accountStore.recordNickname(accountId, nickname),
      // 批 H：自动化侧的自我保护出口。**走状态管理器而不是直写存储** ——
      // 它同时维护进程内投影，绕过去会让本进程随后的判定还以为这个账号是活的。
      pauseAccount: async (accountId, reason) => {
        await accountState.pause(accountId);
        console.warn(`[account-state] 账号已暂停 account=${accountId} reason=${reason}`);
      },
    },
    publishLog,
    edgePublish,
    interactionAuth: new PgInteractionAuthGate({ pool }),
    interactionApiWrites: new PgInteractionApiWrites(pool),
    replyConfig: new ReplyConfigResolver(replyScopes),
    accountPersona,
    environmentHandshake: createEnvironmentHandshakeAuthority(clientUserStore),
    commentApprovalPolicy: approvalPolicy,
    notificationContacts,
    firstPostProgress,
    automationConfigCommands: createAutomationConfigCommands(
      contentSchedule,
      facebookCommentConfig,
    ),
    offboardAdmissionLedger: new PgOffboardAdmissionLedger(pool, target),
    notificationDelivery: apiFeishu.notificationDelivery,
  };

  return {
    target,
    pool,
    authorities,
    apiFeishu,
    pairedCommands,
    panelFacebookGroupTargets,
    publishApproval: {
      authority: publishApprovalAuthority,
      decisionWriter: publishApprovalDecisionWriter,
      outboxRelay: publishApprovalOutboxRelay,
    },
    syncRead: {
      ownerSource: syncReadOwnerSource,
      consumer: syncReadConsumer,
      panelEvidence: createApiSyncReadPanelEvidencePorts(syncReadMirrors),
    },
    contentReads,
    business: {
      startIngress: startBusinessIngress,
    },
  };
}

function registerApiAuthorityRoutes(
  server: InternalHttpServer,
  root: ApiCompositionRoot,
): void {
  const { authorities: port, target } = root;
  const token = requiredEnv('AIDCP_API_INTERNAL_TOKEN');
  registerAccountRosterRoutes(server, port.accountRoster, token, target);
  registerAccountOwnershipRoutes(server, port.accountOwnership, token, target);
  registerAccountRuntimeRoutes(server, port.accountRuntime, token, target);
  registerAutomationPublishLogRoutes(server, port.publishLog, token, target);
  registerEdgePublishCommandRoutes(server, port.edgePublish, token, target);
  registerInteractionAuthRoutes(server, port.interactionAuth, token, target);
  registerInteractionApiWritesRoutes(server, port.interactionApiWrites, token, target);
  registerReplyConfigResolverRoutes(server, port.replyConfig, token, target);
  registerAccountPersonaRoutes(server, port.accountPersona, token, target);
  registerEnvironmentHandshakeRoutes(server, port.environmentHandshake, token, target);
  registerCommentApprovalPolicyRoutes(server, port.commentApprovalPolicy, token, target);
  // 批 H：**排期名额回程刻意未注册** —— 本进程还没有内容排期调度器，
  // 而那条口的属主判据是「这一格是不是我点的火」，账本就在调度器进程内。
  // 注册一条背后没有调度器的路由，就是新造一处「看着接好了、其实永不触发」。
  // 等本进程真的构造排期器时，连同它一起注册（automation 侧客户端已就位、缺席后果已写明）。
  registerNotificationContactsRoutes(server, port.notificationContacts, token, target);
  registerFirstPostProgressRoutes(server, port.firstPostProgress, token, target);
  registerAutomationConfigCommandsRoutes(server, port.automationConfigCommands, token, target);
  registerOffboardAdmissionLedgerRoutes(server, port.offboardAdmissionLedger, token, target);
  registerStructuredNotificationRoutes(server, port.notificationDelivery, token, target);
  // content 侧的两条窄读（change split-cloud-automation-production-runtime，A-3）：
  // 单体在 startContentReadApi 里注册这两条，本 main 此前漏了 ⇒ content 读库内密钥必失败。
  // **无条件注册**、绝不加 `if`：这两条的事实源是本域属主表，缺席不是「本进程没配」而是接线漏了。
  registerRoleModelSelectionRoutes(server, root.contentReads.roleModelSelectionSource);
  registerProviderSecretRoutes(server, root.contentReads.providerSecretReader);
  const publishApprovalToken = requiredEnv('AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN');
  registerPublishApprovalAuthorityRoutes(
    server,
    root.publishApproval.authority,
    publishApprovalToken,
  );
  registerPublishApprovalDecisionWriterRoutes(
    server,
    root.publishApproval.decisionWriter,
    publishApprovalToken,
  );
}

export function registerApiSyncReadOwnerRoute(
  server: InternalHttpServer,
  provider: SyncReadSnapshotProvider,
  target: DeploymentTarget,
  bearerToken: string,
): void {
  registerSyncReadSnapshotRoute(server, provider, {
    owner: 'api',
    executionTarget: target,
    bearerToken,
    streams: API_SYNC_READ_OWNED_STREAMS,
  });
}

export function registerApiSyncReadChangedIngress(
  server: InternalHttpServer,
  consumer: Pick<ApiSyncReadConsumerRuntime, 'refreshStream'>,
  target: DeploymentTarget,
  bearerToken: string,
): void {
  const allowed = new Set<SyncReadChangedStream>(
    API_SYNC_READ_CHANGED_STREAMS,
  );
  const ingress: SyncReadChangedIngress = {
    async handle(signal) {
      if (!allowed.has(signal.stream)) {
        throw new Error(
          `sync_read_changed_stream_not_consumed_by_api:${signal.stream}`,
        );
      }
      await consumer.refreshStream(signal.stream, signal.generation);
    },
  };
  registerSyncReadChangedRoute(server, ingress, {
    executionTarget: target,
    bearerToken,
  });
}

function registerApiSyncReadReadinessRoute(
  server: InternalHttpServer,
  root: ApiCompositionRoot,
  isBusinessIngressStarted: () => boolean,
): void {
  server.registerBearer(
    API_SYNC_READ_READINESS_ROUTE,
    requiredEnv('AIDCP_API_INTERNAL_TOKEN'),
    async () => {
      const health = root.syncRead.consumer.health();
      return {
        service: 'api',
        executionTarget: root.target,
        businessIngressStarted: isBusinessIngressStarted(),
        ...health,
      };
    },
  );
}

export async function startApiService(): Promise<{
  port: number;
  readiness(): SyncReadProcessReadiness;
  close(): Promise<void>;
}> {
  const root = await buildApiCompositionRoot();
  const server = new InternalHttpServer();
  registerApiAuthorityRoutes(server, root);
  registerApiSyncReadOwnerRoute(
    server,
    {
      snapshotFor: ({ stream }) => root.syncRead.ownerSource.snapshot(stream),
    },
    root.target,
    requiredEnv('AIDCP_API_INTERNAL_TOKEN'),
  );
  registerApiSyncReadChangedIngress(
    server,
    root.syncRead.consumer,
    root.target,
    requiredEnv('AIDCP_API_INTERNAL_TOKEN'),
  );
  let businessIngressStarted = false;
  registerApiSyncReadReadinessRoute(
    server,
    root,
    () => businessIngressStarted,
  );
  const port = await server.listen(apiPort());
  let publishApprovalRelayTimer: NodeJS.Timeout | null = null;
  let closing = false;
  const pumpPublishApprovalOutbox = (): void => {
    void root.publishApproval.outboxRelay.runOnce(20).catch((error) => {
      console.warn(
        `[aidcp-api] PublishApproved outbox relay failed; commands remain pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };
  let businessStart: Promise<void> | null = null;
  const startBusinessIfReady = async (): Promise<void> => {
    if (
      closing
      || businessIngressStarted
      || root.syncRead.consumer.readiness().state !== 'ready'
    ) {
      return;
    }
    if (!businessStart) {
      businessStart = (async () => {
        await root.business.startIngress();
        businessIngressStarted = true;
        if (closing) return;
        publishApprovalRelayTimer = setInterval(
          pumpPublishApprovalOutbox,
          60_000,
        );
        publishApprovalRelayTimer.unref?.();
        pumpPublishApprovalOutbox();
      })().finally(() => {
        businessStart = null;
      });
    }
    await businessStart;
  };
  let closePromise: Promise<void> | null = null;
  const stopService = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      root.syncRead.consumer.stop();
      const activeBusinessStart = businessStart;
      if (activeBusinessStart) {
        await activeBusinessStart.catch(() => undefined);
      }
      if (publishApprovalRelayTimer) {
        clearInterval(publishApprovalRelayTimer);
        publishApprovalRelayTimer = null;
      }
      await server.close();
      await root.pool.end();
    })();
    return closePromise;
  };
  try {
    const initial = await root.syncRead.consumer.bootstrap();
    if (initial.failures.length > 0) {
      console.warn(
        `[aidcp-api] sync-read first load incomplete; listener remains live and business ingress stays blocked: ${
          initial.failures.map((failure) => `${failure.stream}=${failure.message}`).join('; ')
        }`,
      );
    }
    await startBusinessIfReady();
    root.syncRead.consumer.startPeriodic(async (report) => {
      if (report.failures.length > 0) {
        console.warn(
          `[aidcp-api] sync-read periodic full snapshot incomplete: ${
            report.failures.map((failure) => `${failure.stream}=${failure.message}`).join('; ')
          }`,
        );
      }
      await startBusinessIfReady();
    });
  } catch (error) {
    await stopService();
    throw error;
  }
  console.log(
    `[aidcp-api] API owner listener active on 127.0.0.1:${port} `
      + `(target=${root.target}; 16 owner route groups; 2 approval groups; `
      + `3 sync-read groups (snapshot/changed/readiness); `
      + `4 paired command clients; `
      + `sync-read readiness=${root.syncRead.consumer.readiness().state}; `
      + `business ingress=${businessIngressStarted ? 'started' : 'blocked'})`,
  );
  return {
    port,
    readiness: () => root.syncRead.consumer.readiness(),
    close: stopService,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApiService().catch((error) => {
    console.error('[aidcp-api] startup failed:', error);
    process.exitCode = 1;
  });
}
