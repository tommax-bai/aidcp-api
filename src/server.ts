import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { parseDeploymentTarget, type DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import {
  isSyncReadFactPayload,
  type SyncReadPayloadByStream,
} from 'aidcp-kernel/kernel/sync-read-facts.js';
import { parseSyncReadPersonaSoul } from 'aidcp-kernel/kernel/persona-soul-parse.js';
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
  AutomationDispatchCommandHttpClient,
  DelegatedTaskTextCommandHttpClient,
} from 'aidcp-transport/transport/operator-command-http.js';
import {
  DelegatedTaskHttpClient,
} from 'aidcp-transport/transport/delegated-task-http.js';
import {
  delegatedTaskRejectionToError,
  operatorCommandId,
  type DelegatedTaskCommandPort,
} from 'aidcp-kernel/kernel/operator-command-port.js';
import { DelegatedTaskServiceError } from 'aidcp-kernel/kernel/delegated-task-types.js';
import {
  PublishDispatchTriggerHttpClient,
} from 'aidcp-transport/transport/publish-dispatch-trigger-http.js';
import { registerProviderSecretRoutes } from 'aidcp-transport/transport/provider-secret-http.js';
import { registerRoleModelSelectionRoutes } from 'aidcp-transport/transport/role-model-selection-http.js';
// 内容进程要用的那六族 + 配置镜像失效信号的落地端。单体在它的 api 内部 API 装配里全注册了，
// 本仓的手写 main 一族都没接 —— 表现不是编译错误，而是对面运行期 `no route`。
import { registerReviewCardDeliveryRoutes } from 'aidcp-transport/transport/review-card-delivery-http.js';
import { registerPublishLogRoutes } from 'aidcp-transport/transport/publish-log-http.js';
import { registerPipelineLogRoutes } from 'aidcp-transport/transport/pipeline-log-http.js';
import { registerPublishCardExitRoutes } from 'aidcp-transport/transport/publish-card-exit-http.js';
import { registerImageModelSelectionRoutes } from 'aidcp-transport/transport/image-model-selection-http.js';
import { registerAccountPlatformRoutes } from 'aidcp-transport/transport/account-platform-http.js';
import { registerConfigMirrorBumpRoutes } from 'aidcp-transport/transport/config-mirror-bump-http.js';
import type { ReviewCardDeliveryPort } from 'aidcp-kernel/kernel/review-card-delivery-port.js';
import type { PublishLogWriter } from 'aidcp-kernel/kernel/publish-log-writer-port.js';
import type { PipelineLogSink } from 'aidcp-kernel/kernel/pipeline-log-contract.js';
import type { PublishCardExitPort } from 'aidcp-kernel/kernel/publish-card-exit-port.js';
import type { ImageModelSelectionSource } from 'aidcp-kernel/kernel/image-model-selection-port.js';
import type { AccountPlatformReader } from 'aidcp-kernel/kernel/platform-types.js';
import type { ConfigMirrorBumpSink } from 'aidcp-kernel/kernel/config-mirror-bump-types.js';
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
import {
  ApiSyncReadSnapshotSource,
  API_OWNED_SYNC_READ_STREAMS,
} from './config/api-sync-read-source.js';
import { FacebookCommentConfigStore } from './config/facebook-comment-config-store.js';
import { FacebookOperationPolicyStore } from './config/facebook-operation-policy-store.js';
import { createPersonaPanel } from './config/persona-facade.js';
import { PersonaStore } from './config/persona-store.js';
import { CategoryConfigStore } from './config/category-config-store.js';
import { CredentialStore } from './config/credential-store.js';
import { ModelConfigStore } from './config/model-config-store.js';
import { MirrorVersionStore } from './config/mirror-version-store.js';
import { PgConfigMirrorBumpSink } from './config/mirror-bump-sink.js';
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
import type { PanelDeps, PanelHandle } from './panel/types.js';
import { startPanelApi } from './panel/panel-server.js';
import { PgPanelStore } from './panel/panel-store.js';
import { parsePanelUsers } from './panel/auth.js';
import { PanelEventFanout } from './panel/panel-event-fanout.js';
import { TokenRevocationStore } from './panel/revocation.js';
import {
  startClientAuthApi,
  type ClientAuthDeps,
  type ClientAuthHandle,
} from './client-auth/client-auth-server.js';
import { LoginRateLimiter } from './client-auth/rate-limiter.js';
import { PanelAutomationHttpClient } from 'aidcp-transport/transport/panel-automation-http.js';
import { PublishStatusHttpClient } from 'aidcp-transport/transport/publish-status-http.js';
import { RiskCommandHttpClient } from 'aidcp-transport/transport/risk-command-http.js';
import { RiskReadHttpClient } from 'aidcp-transport/transport/risk-read-http.js';
import { GroupRouteHttpClient } from 'aidcp-transport/transport/group-route-http.js';
import { AlertResolutionHttpClient } from 'aidcp-transport/transport/alert-resolution-http.js';
import {
  PanelQuotaConfigHttpClient,
  PanelPacingConfigHttpClient,
  PanelSessionLimitsHttpClient,
  PanelResumeConfigHttpClient,
} from 'aidcp-transport/transport/panel-config-http.js';
import { registerPanelEventDeliveryRoutes } from 'aidcp-transport/transport/panel-event-delivery-http.js';
import { probeSchemaShape as probeSchemaShapeFromTransport } from 'aidcp-transport/schema/schema-capability.js';
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
import { PublishPipelineLogStore } from './publish-agent/publish-pipeline-log-store.js';
import { createPublishUiUpdateProducer } from './publish-agent/publish-ui-update-producer.js';
import {
  createApiContentSchedulerRuntime,
  type ApiContentSchedulerRuntime,
} from './api-content-scheduling.js';
import { FacebookGroupJoinAutomationStore } from './config/facebook-group-join-automation-store.js';
import { ContentSchedulingHttpClient } from 'aidcp-transport/transport/content-scheduling-http.js';
import { FacebookPublishMediaAuthorityHttpClient } from 'aidcp-transport/transport/content-media-usage-http.js';
import { registerScheduleFeedbackRoutes } from 'aidcp-transport/transport/api-aux-authority-http.js';
import { isWeekActiveAt } from 'aidcp-kernel/kernel/week-active-mask.js';
import {
  API_PG_OWNERS,
  type ApiSchemaGateReceipt,
} from './api-schema-gate-startup.js';

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

/**
 * 本进程注册快照路由的流集合。**从属主源那份唯一清单取，MUST NOT 在这里再抄一份。**
 *
 * 抄第二份的代价实测过：这里曾比属主源少一条 `facebook_operation_policy`，
 * 于是自动化进程的消费方永远拿不到那条流 ⇒ 就绪度永远 not_ready ⇒ 业务入口永不放行 ⇒
 * **边-云端口不监听、边缘一台都连不上**，而本进程自己一切正常、日志一句异常都没有。
 */
export const API_SYNC_READ_OWNED_STREAMS = API_OWNED_SYNC_READ_STREAMS;

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
    imageModelSelection: ImageModelSelectionSource;
    /** 属主缺 `getPlatformOrNull` ⇒ undefined ⇒ **不注册该路由**（绝不注册一条注定 500 的）。 */
    accountPlatform: AccountPlatformReader | undefined;
    reviewCardDelivery: ReviewCardDeliveryPort;
    publishLogWriter: PublishLogWriter;
    pipelineLogSink: PipelineLogSink;
  };
  /**
   * 飞书出口（候审卡 / 指令结果 / 图片上传 / 默认会话解析 / 审批信号），属主是本进程的飞书段。
   * 单列一条是因为它比 `contentReads` 晚构造（要先有飞书段），不是因为语义不同。
   * 六条方法里只有写审批信号那条带 bearer，令牌与内容进程那侧同一个 env 键。
   */
  contentPublishCardExit: PublishCardExitPort;
  /**
   * 跨域配置镜像失效信号的**落地端**。生产方是 automation（它不该持有本域库的连接），
   * 经内部 HTTP 把 bump 推给本进程，由本进程在 api 库里一笔事务做「inbox 去重 + 推版本」。
   */
  configMirrorBumpSink: ConfigMirrorBumpSink;
  business: {
    startIngress(): Promise<void>;
  };
  /**
   * 内容排期调度器（change wire-content-scheduler-into-api-process）。
   * 拆开之前它没有任何进程在跑；本进程是它按分工该在的地方。
   */
  contentScheduler: ApiContentSchedulerRuntime;
  /**
   * 面板 API（管理后台后端）。`port` 为 null 即不启用——沿用单体的门控语义。
   * `eventFanout` 同时是面板事件的**入口**（automation 经内部 HTTP 推进来）与**出口**（面板 ws 订阅）。
   */
  panel: { deps: PanelDeps; eventFanout: PanelEventFanout; port: number | null };
  /** 客户鉴权 API（桌面客户端登录 / 取环境）。`port` 为 null 即不启用。 */
  clientAuth: { deps: ClientAuthDeps; port: number | null };
}

/**
 * 可选端口：**没配就是没配**，绝不给默认值。
 *
 * 猜一个默认端口的两种结局都不好：猜中了会跟单体抢同一个端口（谁先起谁赢，另一个静默失败），
 * 猜不中则是一个没有任何人访问的监听口，而它看起来跟「工作正常」一模一样。
 */
function readOptionalPort(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer in 1..65535`);
  }
  return port;
}

/**
 * 「这台机器上哪些端口不归我」的人工名单（单体一直读的那个键）。
 *
 * 它不是配置项而是**护栏**：dev 同机另有一整套别人的服务，把面板口配错成邻居的端口时，
 * 表现不是启动失败而是**把对方顶掉**。派生进程此前不读这个键 —— 护栏在搬家路上掉了，
 * 而掉了这件事没有任何现象，直到真配错那一次。
 */
function parseForbiddenPorts(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0);
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

/**
 * 形状探测：**用共享包那一份，别在这里另写一个**。
 *
 * 本文件此前有一份手写的：只查表在不在，`columns` 与 `indexes` **恒返回空集合**。
 * 它满足类型、编译全过、单测也不碰它；但凡「要求里带列或索引」的能力，判定都必然不是 ready ——
 * 表现是**进程启动直接失败**，错误文案还逐条列出那些**其实一个不缺**的列
 * （实测：本进程连的 aidcp_api 库里那三张表与全部列都在，是这份探测看不见列）。
 *
 * 这类「答得出形状、答的却是空」的桩比缺席更贵：缺席会报未实现，空答案把排查引向数据库。
 */
const probeSchemaShape: SchemaProber = (client, tables) =>
  probeSchemaShapeFromTransport(client, tables);

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
  // 发布管线角色执行日志（`publish_pipeline_logs`，本域属主表）。**必须显式传池**：
  // 这个存储的构造参数缺省会自建一个连自己默认库的池 —— 物理拆库之后那是一个不存在的库，
  // 而它不在启动期报错，只会在第一次写日志时炸，且炸在内容进程那一侧看起来像「对面挂了」。
  // 本进程自己不写它，构造只为把那条路由喂给内容进程。
  const publishPipelineLogStore = new PublishPipelineLogStore({ pool });
  /**
   * 配置镜像失效信号的**落地端**：本域库里一笔事务做「按去重键入 inbox + 推版本」。
   *
   * **不调 versionStore.init()**：那是一条 `CREATE TABLE IF NOT EXISTS` 的运行期建表路径，
   * 而本仓的 schema 只由迁移管（0062 / 0076 已建两张表）。
   *
   * ⚠️ **生产方那一侧今天还没接线**：自动化进程既没建失效信号的中继、
   * 四个限频配置存储也都没传版本推进器 ⇒ 这条通道两端里只有本端就位。
   * 照样注册路由，理由与面板事件入口那条相同：先让「对面接得住」成立，
   * 免得接生产方那天才发现路由根本不存在。缺的另一半已具名登记，MUST NOT 读成「补完这里就通了」。
   */
  /**
   * 本域配置镜像版本表的写口。
   *
   * **本进程有真实写口，所以必须接它**：客户端建环境那条链路就活在本进程里，它一笔事务
   * 往 Facebook 运营策略与主浏览面两张表各插一行 —— 那正是同步读那条流的载荷来源。
   * 不推版本的后果不是「配置晚点生效」，而是同一个游标发出两种载荷摘要、消费方永久拒收：
   * 2026-08-04 dev 实测，一个客户端建了个新 Facebook 环境之后，单体重启**直接启动失败**。
   */
  const mirrorVersionStore = new MirrorVersionStore({ pool });
  const configMirrorBumpSink: ConfigMirrorBumpSink = new PgConfigMirrorBumpSink({
    pool,
    versionStore: mirrorVersionStore,
    logger: console,
  });
  const clientUserStore = new ClientUserStore({
    pool,
    mirrorVersionBumper: mirrorVersionStore,
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
    // 同上：本进程既是这张表的读方也是写方（面板与客户端两条写口都在这里），
    // 不接推进器 = 写完不推版本 = 同步读那条流下一次就卡死。
    mirrorVersionBumper: mirrorVersionStore,
    schemaProber: probeSchemaShape,
    executionTarget: target,
  });
  /**
   * Facebook 自动加群的每账号配置。**本进程此前不构造它**，而排期器的独立加群动作
   * 三道闸（开关 / 日上限 / 时段）全读它——不注入即整个加群动作静默跳过。
   */
  const facebookGroupJoinAutomation = new FacebookGroupJoinAutomationStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
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
    facebookGroupJoinAutomation.init(),
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
    // 图片模型选择：内容进程的调用点是**同步**的、在热闭包里，所以跨进程形态是
    // 「异步取源 + 对面本地镜像」，而不是一个 HTTP 客户端。本进程只负责取源那一半。
    // 对面取不到时的表现是「沿用保守默认」并每分钟打一行日志 —— 不崩、不报警、
    // 只是**配的图片模型悄悄不生效**（2026-08-04 dev 上实测到的就是这一条）。
    imageModelSelection: {
      fetchImageModelSelection: async () => {
        const cached = modelConfigStore.getCached();
        return { imageProvider: cached.imageProvider, imageModel: cached.imageModel };
      },
    } satisfies ImageModelSelectionSource,
    // 账号平台窄读（`accounts` 是本域属主表）。属主缺这个方法就**不注册**，
    // 绝不注册一条注定 500 的路由 —— 与单体同口径。
    accountPlatform: accountStore.getPlatformOrNull
      ? ({
          getPlatformOrNull: (accountId: string) => accountStore.getPlatformOrNull!(accountId),
        } satisfies AccountPlatformReader)
      : undefined,
    // 候审卡该不该发的判定：要的两张表（分组稿件策略 / 客户审批归属）都是本域属主，
    // 故判定留本进程，内容进程只问结论。**每一条失败路径都回「保留飞书卡」**：
    // 判不出来时少发一张卡 = 稿件从此没人审，而多发一张只是噪音。
    reviewCardDelivery: {
      resolveReviewCardDelivery: async (accountId: string) => {
        let policy: Awaited<
          ReturnType<ApprovalPolicyStore['getGroupPublishPolicyForAccount']>
        >;
        try {
          policy = await approvalPolicy.getGroupPublishPolicyForAccount(accountId);
        } catch (error) {
          console.warn(
            `[approval-policy] 分组稿件策略读取失败，保留飞书卡 account=${accountId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return { send: true, reason: 'policy_read_failed' };
        }
        if (policy.delivery !== 'client_only') return { send: true, reason: 'client_and_feishu' };
        if (!policy.groupLabel) return { send: true, reason: 'account_group_missing' };
        try {
          const reachability =
            await clientUserStore.hasEnabledClientApprovalReachability(accountId);
          if (reachability.reachable) {
            return { send: false, reason: 'suppressed_by_client_only_policy' };
          }
          console.warn(
            `[approval-policy] client_only 账号客户审批归属不可证，保留飞书卡 account=${accountId}`
              + ` group=${policy.groupLabel} reason=${reachability.reason}`,
          );
          return { send: true, reason: `client_reachability_${reachability.reason}` };
        } catch (error) {
          console.warn(
            `[approval-policy] 客户审批归属读取失败，保留飞书卡 account=${accountId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return { send: true, reason: 'client_reachability_read_failed' };
        }
      },
    } satisfies ReviewCardDeliveryPort,
    /** 发布台账窄写口：`publish_log` 是本域属主表，内容进程经这四条写。 */
    publishLogWriter: publishLogStore as PublishLogWriter,
    /** 发布管线角色执行日志：`publish_pipeline_logs` 同属本域。 */
    pipelineLogSink: publishPipelineLogStore as PipelineLogSink,
  };

  const pairedCommands = {
    edgeResume: new EdgeResumeCommandHttpClient(automationHttp, automationToken, target),
    facebookScope: new FacebookScopeCommandHttpClient(automationHttp, automationToken, target),
    publishUi: new PublishUiUpdateCommandHttpClient(automationHttp, automationToken, target),
    personaGenerator: new PersonaGeneratorCommandHttpClient(contentHttp, contentToken, target),
  };

  /**
   * 调度启停（运营指令，不属 4a paired command 那一族，故单独构造）：
   * 调度引擎活在 automation 进程里，本进程读与写都得跨那一跳。
   * 服务端那一半已在 `aidcp-automation` 的 `main()` 里注册（automation `2f5f6a9`）——
   * **接客户端之前去对面 `main()` 里确认过路由真被注册了**，不是「客户端建得出来就算接通」。
   */
  const automationDispatchCommand = new AutomationDispatchCommandHttpClient(
    automationHttp,
    automationToken,
    target,
  );

  /**
   * 委托任务指令面的远端形态：**两个客户端合成一个 7+1 端口**。
   *
   * 不把它们合进同一个传输文件：一个是端口面（既有 7 方法）、一个是指令面（自由文本入口），
   * 合并会让路由表失去 `satisfies Record<keyof Port, string>` 那道
   * 「端口加了方法而路由没跟上就编译红」的保护。
   *
   * **逐方法显式转调，MUST NOT 用对象展开**：展开拿不到类实例原型上的方法，
   * 那种错编译得过、要真跑起来才现形。
   *
   * 服务端那一半在 `aidcp-automation` 的 `main()` 里注册（`registerDelegatedTaskRoutes`
   * + `registerDelegatedTaskTextCommandRoutes`）——**接之前去对面 `main()` 里确认过**，
   * 不是「客户端建得出来就算接通」：客户端只吃基址与令牌，路由不在对面照样编译得过、
   * 两仓测试各自全绿，只有真跑两个进程才 404，而那个 404 会被读成「对面版本落后」。
   */
  const delegatedTasks: DelegatedTaskCommandPort = ((): DelegatedTaskCommandPort => {
    const seven = new DelegatedTaskHttpClient(automationHttp, automationToken, target);
    const text = new DelegatedTaskTextCommandHttpClient(automationHttp, automationToken, target);
    return {
      createDraft: (intent) => seven.createDraft(intent),
      confirm: (taskId, version) => seven.confirm(taskId, version),
      pause: (taskId, version) => seven.pause(taskId, version),
      resume: (taskId, version) => seven.resume(taskId, version),
      cancel: (taskId, version) => seven.cancel(taskId, version),
      get: (taskId) => seven.get(taskId),
      list: (filter) => seven.list(filter),
      createFromText: (input) => text.createFromText(input),
    };
  })();

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
    // 自由文本委托（`/delegate`）。语义逐条照单体的 api 模式，**不重组新形状**：
    // 四种非成功回执各有各的真相，压成一句「失败」会让运营分不出该重试还是该改参数。
    delegate: async (text, context) => {
      // 幂等键：`requestKey` 取飞书消息 id（跨重投稳定），`scope` 取来源会话。
      // **拿不到消息 id 就拒发，绝不用随机数或当前时刻兜底** —— 那样键跨重试就变了，
      // 等于宣布这套幂等不存在（反面样板就在本文件上面那条 edge resume 上）。
      const requestKey = context?.messageId;
      const commandId = requestKey
        ? operatorCommandId({
            kind: 'delegated_task_text',
            scope: context?.chatId ?? 'feishu',
            requestKey,
          })
        : null;
      if (!commandId) {
        throw new DelegatedTaskServiceError(
          'command_key_unavailable',
          '这条消息没有可用于判重的稳定标识，未受理（重发同一条消息不会重复执行，但本次没有执行）。',
          400,
        );
      }
      const receipt = await delegatedTasks.createFromText({
        commandId,
        text,
        ...(context?.messageId ?? context?.chatId
          ? { sourceRef: (context?.messageId ?? context?.chatId)! }
          : {}),
        ...(context?.chatId ? { originChatId: context.chatId } : {}),
      });
      if (receipt.outcome === 'not_delivered') {
        // **MUST NOT 表述成已受理 / 已排队。**「没接线」是对面明确答出来的结论，
        // 与「结果未知」（对面没答上来，走抛）是两回事。
        return {
          command: text,
          ok: false,
          level: 'error' as const,
          title: '委托未送达',
          message: `这台机器上没有接这条指令的处理器（${receipt.reason}），本次**没有**执行。`,
        };
      }
      if (receipt.outcome === 'collision') {
        return {
          command: text,
          ok: false,
          level: 'error' as const,
          title: '委托键冲突',
          message: '同一把幂等键已被用于另一个作用域，未受理；请重新发起。',
        };
      }
      if (receipt.outcome === 'rejected') {
        // 还原成业务错误再抛：调用方（CommandRouter）对它的渲染与单体逐位一致
        //（黄色「委托任务需要补充信息」）。
        throw delegatedTaskRejectionToError(receipt.rejection);
      }
      const result = receipt.result;
      if (result.kind === 'control') {
        const task =
          result.action === 'pause'
            ? await delegatedTasks.pause(result.taskId)
            : result.action === 'resume'
              ? await delegatedTasks.resume(result.taskId)
              : result.action === 'cancel'
                ? await delegatedTasks.cancel(result.taskId)
                : await delegatedTasks.get(result.taskId);
        return {
          command: text,
          ok: true,
          title: '委托任务当前状态',
          message:
            `任务 ${task.id} 当前为 ${task.status}，真实完成 `
            + `${task.progress.successCount}/${task.targetSuccessCount}。`,
          accountId: task.accountId,
          accountName: task.accountName,
          platformName: task.platform,
          card: apiFeishu.buildDelegatedTaskProgressCard(task),
        };
      }
      if (result.autoQueued) {
        return {
          command: text,
          ok: true,
          title: '委托任务已直接排队',
          message: '精确命令已直接入队；结果由任务自身的结果卡回报。',
          accountId: result.task.accountId,
          accountName: result.task.accountName,
          platformName: result.task.platform,
          silent: true,
        };
      }
      return {
        command: text,
        ok: true,
        title: result.created ? '委托任务待确认' : '已存在相同待确认任务',
        message: '确认前不会执行任何平台写动作。',
        accountId: result.task.accountId,
        accountName: result.task.accountName,
        platformName: result.task.platform,
        card: apiFeishu.buildDelegatedTaskConfirmationCard(result.confirmation),
      };
    },
    publish: async () => {
      throw new Error('automation_operator_command_unavailable:publish');
    },
    comment: async () => {
      throw new Error('automation_operator_command_unavailable:comment');
    },
    // 调度启停：语义逐条照单体的 api 模式（cloud `src/server.ts` 那两处），**不重组新形状**。
    dispatch: async (accountId, action) => {
      const receipt = await automationDispatchCommand.setDispatch({
        // 一次运营动作 = 一个键。传输层重试沿用同一个键（幂等由接收方按键判），
        // 所以这里的随机不是「每次重试新随机一个」那种把幂等键做废的写法
        // （反面样板就在本文件上面那条 edge resume 上，见裁定文档 §3 步骤 0-b）。
        commandId: randomUUID(),
        accountId,
        action,
      });
      // 三种非成功回执各有各的真相，MUST NOT 压成一句「失败」——用户拍板的这一版要求
      //「点了失败给明确提示」，提示的内容就从这里来。
      if (receipt.outcome === 'not_delivered') {
        throw new Error(`调度指令没有送达处理器（${receipt.reason}），本次启停未生效`);
      }
      if (receipt.outcome === 'collision') {
        throw new Error('同一条指令 id 被用在了另一个账号上，本次未执行');
      }
      // 回执里的 state 与面板要的形状**逐字相同**，原样回传。别在这里重组一个新对象：
      // 多写一遍就多一处会漂的地方，而且漂了不报错。
      return receipt.state;
    },
    // 状态灯：**原样回三态**（task 1.3a）。这里曾写着 `() => false`，把「读不到调度引擎」
    // 答成「调度引擎正常停着」——面板上 false 的含义是后者，运营看到它什么都不会做。
    // 客户端读失败时**抛**（`api_authority_unavailable`），MUST NOT 在这里 catch 成 `active:false`。
    dispatchActive: () => automationDispatchCommand.readDispatchActivity(),
    managementChatIds,
    logger: console,
  });
  let businessIngressStarted = false;
  const startBusinessIngress = async (): Promise<void> => {
    if (businessIngressStarted) return;
    await apiFeishu.startIngress({
      commandFace,
      // 委托卡片上那几个按钮（确认 / 暂停 / 恢复 / 取消）。**与自由文本那条是两个入口**：
      // 只接前者的话，运营发得出委托、却按不动自己那张卡上的任何按钮，
      // 而卡片照常渲染出按钮来 —— 看着能点、点了什么都不发生。
      delegatedTasks,
      ...publishOwnerHandlers.feishuApprovalIngress,
    });
    businessIngressStarted = true;
  };

  const syncReadOwnerSource = new ApiSyncReadSnapshotSource({
    executionTarget: target,
    pool,
    // **按引用取用共享包那一份**，MUST NOT 在此就地实现「解析 + 归一 + 失败回 null」。
    // 此前这里用的是本仓通用装载器（它会带上 api 段自管的 engagement_rules 等字段、
    // 且不带兜底），单体那一侧用的是人设闭子集编解码器 —— 同一份人设文本解出两种结构，
    // 同一个游标发出两种载荷摘要，消费方按设计整条拒收，而两侧的行为测试各自全绿。
    // 2026-08-04 dev 切流演练实测过一次（游标 902）。
    parseSoul: parseSyncReadPersonaSoul,
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
      // 账号目录（显示名 + 别名候选）。自动化进程的委托解析按昵称选号，读的就是这一条；
      // 守卫花名册那一条给不出这两个字段，缺了会让每一条「给<昵称>…」都回「无可用昵称」。
      listAccountDirectory: () => accountStore.listAccountDirectory(),
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
    // 台账类**刻意只实现写面**（它自己 `implements Omit<…, 'hasPendingRevocationHold'>`）：
    // 读面要先按账号解析出环境键，事实源在客户花名册那边。照单体的接法**委托属主自己那一份**，
    // MUST NOT 在台账类里把同一条 SQL 再抄一遍 —— 它的谓词与失败方向（抛，MUST NOT 吞成 false）
    // 都是有讲究的，抄第二份的现形方式不是报错，而是某天两份谓词漂开、
    // 一个正在被撤权的环境被重新放行。
    offboardAdmissionLedger: Object.assign(
      new PgOffboardAdmissionLedger(pool, target),
      {
        hasPendingRevocationHold: (accountId: string) =>
          clientUserStore.hasPendingRevocationHold(accountId),
      },
    ),
    notificationDelivery: apiFeishu.notificationDelivery,
  };

  /**
   * 内容排期调度器（change wire-content-scheduler-into-api-process）。
   *
   * **接之前去自动化侧的 `main()` 里逐条确认过那族路由无条件注册**
   *（`registerContentSchedulingRoutes(root.internalServer, …)`），不是「客户端建得出来就算」。
   * 派生服务的启动入口各自手写、从不自动同步，注册集合会悄悄少于单体；漏一条的表现是
   * 编译过、两仓测试全绿、只有真跑两个进程才 404，而那个 404 会被读成「对面版本落后」。
   *
   * 令牌用的是**自动化方向那把**（与三个成对指令客户端同源）。发布授权那族另挂专用令牌、
   * 两者不互相回落，拿错了每次都判未授权而编译期看不见。
   */
  const contentScheduler = createApiContentSchedulerRuntime({
    executionTarget: target,
    automation: new ContentSchedulingHttpClient(automationHttp, automationToken, target),
    // 素材可用数的属主在内容服务。不接这一跳的代价不是报错，而是每一格都按 0 处置、
    // 日志说「素材不足」而事实是根本没问——两件事的处置完全相反。
    availablePublishMediaCount: (accountId) =>
      new FacebookPublishMediaAuthorityHttpClient(
        contentHttp,
        contentToken,
        target,
      ).availableCount(accountId),
    schedule: contentSchedule,
    publishLog: publishLogStore,
    contactAttempts: contentSchedule,
    joinAutomationFor: (accountId) => facebookGroupJoinAutomation.getForAccount(accountId),
    effectiveFacebookOperationMode: async (accountId) =>
      (await facebookOperationPolicy.resolveForAccount(accountId)).mode,
    getPlatform: async (accountId) =>
      (await accountStore.getPlatformOrNull(accountId)) ?? 'xiaohongshu',
    isWeekActiveAt,
    deliver: async (input) => {
      await apiFeishu.notificationDelivery.deliver({
        commandId: `content-schedule:${input.accountId}:${input.title}:${Date.now()}`,
        notification: { kind: 'command_result', input },
      });
    },
    logger: console,
  });

  // ══ 面板 API 与客户鉴权 API（change deploy-derived-services-to-dev）══════════════════
  //
  // 这两块此前**在本仓一次都没被调用过**：`startPanelApi` / `startClientAuthApi` 的实现随属主
  // 搬进了本仓，手写的 main() 却从头到尾没有它们的调用点。后果不是「少两个接口」——
  // 单体一停，管理后台整个打不开、桌面客户端登不上，而这两件事在本仓的编译期与测试里
  // 完全看不出来（代码在、没人调，跟「调了但对面 404」一样安静）。
  //
  // 端口沿用单体的门控语义：**未设端口即不启用**（MUST NOT 猜一个默认端口——猜中了会跟单体抢，
  // 猜不中则是一个没人访问的监听口）。
  const panelEventFanout = new PanelEventFanout();
  const syncReadPanelEvidence = createApiSyncReadPanelEvidencePorts(syncReadMirrors);
  const panelDeps: PanelDeps = {
    publishLogStore,
    botChatStore: apiFeishu.botChatStore,
    eventBus: panelEventFanout,
    // 本进程**没有**边缘登记表——边-云服务端在自动化进程里。在线数走同步读镜像
    // （`edgePresenceEvidence`，下一行），面板注入了镜像就不会调这两个方法。
    // 真被调到时**响亮抛错**：返回 0 会被读成「一台边缘都没在线」，那是编出来的事实。
    edgeServer: {
      edgeCount: () => {
        throw new Error(
          'edge_registry_not_in_api_process: 边缘登记表在自动化进程，本进程没有立场答这个数',
        );
      },
      onlineEdgeCount: () => {
        throw new Error(
          'edge_registry_not_in_api_process: 在线边缘数走 edgePresenceEvidence 镜像，不走本地权威',
        );
      },
    },
    // 三个同步读镜像口整体展开：**别在这里重新包一层**——包一层就得自己处理「口不存在」，
    // 而那正是把「镜像没就绪」悄悄变成「答 0」的入口。
    ...syncReadPanelEvidence,
    panelStore: new PgPanelStore({ pool, automation: new PanelAutomationHttpClient(automationHttp) }),
    publishStatus: new PublishStatusHttpClient(contentHttp),
    riskCommands: new RiskCommandHttpClient(automationHttp, { executionTarget: target }),
    riskRead: new RiskReadHttpClient(automationHttp),
    writeApprovalSignal: (requestId, approved, payload, decidedBy) =>
      writeApprovalDecision(requestId, approved, payload, { decidedBy, decidedVia: 'console' }),
    readApprovalDispatchStates: (requestIds) => publishApprovalStore.readActiveMany(requestIds),
    commandActions: commandFace.panelCommandActions,
    revocation: new TokenRevocationStore(),
    delegatedTasks,
    accountAttr: {
      setGroupLabel: (accountId, groupLabel) => accountStore.setGroupLabel(accountId, groupLabel),
      setContactInfo: (accountId, contactInfo) =>
        accountStore.setContactInfo(accountId, contactInfo),
    },
    facebookCommentConfig: {
      get: (accountId) => facebookCommentConfig.getForAccount(accountId),
      set: (accountId, patch, updatedBy) =>
        facebookCommentConfig.setAccount(accountId, patch, updatedBy),
    },
    facebookOperationPolicy,
    facebookGroupTargets: panelFacebookGroupTargets,
    contentSchedule: {
      getGlobalView: () => {
        const global = contentSchedule.getGlobal();
        return {
          contentActiveMask: global?.contentActiveMask ?? null,
          overridden: global !== null,
          updatedAt: global?.updatedAt ?? null,
          updatedBy: global?.updatedBy ?? null,
        };
      },
      listCatalog: () => contentSchedule.listCatalog(),
      setGlobal: (mask, updatedBy) =>
        contentSchedule.setGlobal({ contentActiveMask: mask }, updatedBy),
      setAccount: (accountId, patch, updatedBy) =>
        contentSchedule.setAccount(accountId, patch, updatedBy),
      // `setJoinGroupAutomation` **有意不接**（它是可选口）：单体那份写完加群配置之后还要拼一张
      // 目录视图，而那张视图要读风控日配额与群目标范围——两样都在自动化域，且后者今天对面
      // 根本没注册那族路由。接一个「读不到就填 0」的版本，会让运营在后台看到一个编出来的上限。
      // 缺席时面板逐路由答「未提供」，那是**答案**；填 0 是谎。已登记 backlog。
    },
    persona: personaPanel,
    notificationContact: notificationContacts,
    approvalPolicies: {
      list: async () => {
        const [accounts, groups, coverage] = await Promise.all([
          approvalPolicy.listAccountPolicies(),
          approvalPolicy.listGroupPolicies(),
          clientUserStore.listClientApprovalCoverageByGroup(),
        ]);
        const coverageByGroup = new Map(coverage.map((row) => [row.groupLabel, row]));
        return {
          accounts,
          groups: groups.map((row) => ({
            ...row,
            activeAccountCount: coverageByGroup.get(row.groupLabel)?.activeAccountCount ?? 0,
            reachableAccountCount: coverageByGroup.get(row.groupLabel)?.reachableAccountCount ?? 0,
          })),
        };
      },
      listEnvironmentCommentPolicies: (envKeys) =>
        approvalPolicy.listEnvironmentCommentPolicies(envKeys),
      getEnvironmentCommentPolicy: (envKey) => approvalPolicy.getEnvironmentCommentPolicy(envKey),
      setEnvironmentCommentMode: (envKey, mode, updatedBy) =>
        approvalPolicy.setEnvironmentCommentMode(envKey, mode, updatedBy),
      setGroupPublishDelivery: (groupLabel, delivery, updatedBy) =>
        approvalPolicy.setGroupPublishDelivery(groupLabel, delivery, updatedBy),
    },
    clientUsers: clientUserStore,
    slowStartDisabled: process.env.AIDCP_SLOW_START_DISABLED === 'true',
    notificationRoutes: new GroupRouteHttpClient(automationHttp),
    alertStore: new AlertResolutionHttpClient(automationHttp),
    quotaConfig: new PanelQuotaConfigHttpClient(automationHttp),
    pacingConfig: new PanelPacingConfigHttpClient(automationHttp),
    sessionLimits: new PanelSessionLimitsHttpClient(automationHttp),
    resumeConfig: new PanelResumeConfigHttpClient(automationHttp),
  };
  const clientAuthDeps: ClientAuthDeps = {
    store: clientUserStore,
    // **客户侧的撤销表与面板那份各是各的**：共用一张表等于把两个信任域并成一个。
    revocation: new TokenRevocationStore(),
    rateLimiter: new LoginRateLimiter(),
    referenceDraftCountForAccount: (accountId) =>
      publishLogStore.countReferenceDraftsForAccount(accountId),
    pendingDrafts: publishLogStore,
    publishSchedule: publishLogStore,
    facebookOperationPolicy,
    commentApprovalPolicy: {
      getForOwnedEnv: (userId, envKey) =>
        approvalPolicy.getOwnedEnvironmentCommentPolicy(userId, envKey),
      setForOwnedEnv: (userId, envKey, mode, updatedBy) =>
        approvalPolicy.setOwnedEnvironmentCommentMode(userId, envKey, mode, updatedBy),
    },
    delegatedTasks,
  };

  return {
    target,
    pool,
    authorities,
    apiFeishu,
    contentScheduler,
    pairedCommands,
    panelFacebookGroupTargets,
    panel: { deps: panelDeps, eventFanout: panelEventFanout, port: readOptionalPort('AIDCP_PANEL_PORT') },
    clientAuth: { deps: clientAuthDeps, port: readOptionalPort('AIDCP_CLIENT_AUTH_PORT') },
    publishApproval: {
      authority: publishApprovalAuthority,
      decisionWriter: publishApprovalDecisionWriter,
      outboxRelay: publishApprovalOutboxRelay,
    },
    syncRead: {
      ownerSource: syncReadOwnerSource,
      consumer: syncReadConsumer,
      panelEvidence: syncReadPanelEvidence,
    },
    contentReads,
    contentPublishCardExit: apiFeishu.publishCardExit,
    configMirrorBumpSink,
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
  // 批 H → change wire-content-scheduler-into-api-process：**排期名额回程现在有真落点了**。
  // 落点与本进程调度器**共用同一个方法**（`scheduler.reportNotStarted`），不是第二条写入路径 ——
  // 小时格账本只有调度器自己那一本，第二条路径就是第二本账，而两本账一定会漂。
  // 没有调度器的进程上调用它 MUST 响亮抛具名错误、MUST NOT 回 false：false 读作
  //「调度器看过了、没接管」，与「这个进程根本没有调度器」完全同形，而后者是配置问题、必须有人去修。
  registerScheduleFeedbackRoutes(
    server,
    {
      reportScheduledTaskNotStarted: (accountId, action, reason) =>
        root.contentScheduler.reportScheduledTaskNotStarted(accountId, action, reason),
    },
    token,
    target,
  );
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
  // 同一类漏注册的**另外六族**（2026-08-04 实测：内容进程每分钟打一次
  // 「取图片模型失败，沿用保守默认」—— 配的图片模型悄悄不生效，不崩、不报警）。
  // 全部无条件注册、全部不带令牌，与内容进程那侧的客户端一一对应；
  // 唯一带令牌的是写审批信号那一条，它在下面那族里单独走 bearer。
  registerReviewCardDeliveryRoutes(server, root.contentReads.reviewCardDelivery);
  registerPublishLogRoutes(server, root.contentReads.publishLogWriter);
  registerPipelineLogRoutes(server, root.contentReads.pipelineLogSink);
  registerImageModelSelectionRoutes(server, root.contentReads.imageModelSelection);
  // 账号平台窄读：**属主缺这个方法就不注册**，绝不注册一条注定 500 的路由。
  // 与上面几条不同，这里的守卫不是形式主义——账号存储是可打桩的，桩上没有这个方法。
  if (root.contentReads.accountPlatform) {
    registerAccountPlatformRoutes(server, root.contentReads.accountPlatform);
  } else {
    console.warn(
      '[aidcp-api] 账号平台读路由未注册（账号存储没有该方法）'
        + ' —— 内容进程的账号平台判定会失败，那不是「这个账号没有平台」',
    );
  }
  const publishApprovalToken = requiredEnv('AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN');
  registerPublishCardExitRoutes(server, root.contentPublishCardExit, publishApprovalToken);
  registerConfigMirrorBumpRoutes(server, root.configMirrorBumpSink);
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

/**
 * 本进程一条能力的启动结论。**注册了什么与没注册什么由同一个数组得出**——
 * 两份各写各的清单必然漂，而漂了之后「日志说注册了」与「实际注册了」不再是同一件事。
 */
export interface ApiStartupCapability {
  name: string;
  registered: boolean;
  /** 未注册时**必须**具名说清依赖缺在哪；已注册时留空。 */
  reason?: string;
}

/**
 * 启动日志里那句「注册了什么 / 没注册什么」。
 *
 * 缺席一律显式说出，**MUST NOT 与「已注册且空闲」同形**：后者是正常态，前者是配置或依赖
 * 出了问题、需要有人去修，而两者在「进程活着、端口通」这个维度上完全一样。
 */
export function formatApiCapabilityRoster(
  capabilities: readonly ApiStartupCapability[],
): string {
  const registered = capabilities.filter((entry) => entry.registered).map((entry) => entry.name);
  const absent = capabilities.filter((entry) => !entry.registered);
  const absentText =
    absent.length === 0
      ? '无'
      : absent.map((entry) => `${entry.name}（${entry.reason ?? '原因未具名'}）`).join('、');
  return `已注册=${registered.length === 0 ? '无' : registered.join('、')}；未注册=${absentText}`;
}

export async function startApiService(options: {
  /**
   * schema 契约门跑过了的回执。**必填、无缺省，且外部造不出来**
   * （只能由 {@link runApiStartupSchemaGate} 返回）。
   *
   * 它在这里是为了把「门必须先跑、且跑在建池之前」变成编译期可见的顺序约束：
   * 本函数第一句就建池（`buildApiCompositionRoot`），门若跑在它之后，落后的 schema
   * 会先被打开连接、再由某个存储在某次调用上炸掉，而不是在启动那一刻被挡住。
   * 而「没调门」在行为上什么都不表现 ⇒ 行为测试原理上看不见它，只能由类型担保。
   */
  schemaGate: ApiSchemaGateReceipt;
}): Promise<{
  port: number;
  readiness(): SyncReadProcessReadiness;
  close(): Promise<void>;
}> {
  // 门判过的属主集合 MUST 与本进程真正建池的属主集合逐个吻合——对不上即拒绝启动，不是告警。
  // 判少了：真在用的库没被校验过（门看着绿、其实什么都没校验到）；
  // 判多了：本进程根本不连那个库，却在替它的 schema 背书。
  const judged = [...options.schemaGate.owners].sort().join(',');
  const opened = [...API_PG_OWNERS].sort().join(',');
  if (judged !== opened) {
    throw new Error(
      `schema_gate_owner_scope_mismatch: 门判了 [${judged}]，本进程建池 [${opened}]。`
        + '两者必须一致——否则要么真在用的库没被校验，要么在替本进程不连的库背书。',
    );
  }
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
  // automation → api 的面板事件入口。**对面今天还没有推送方**（automation 侧未建客户端），
  // 照样注册：先让「对面接得住」成立，别等写推送方那天才发现路由不存在——
  // 那是本仓已经连撞多次的形态（客户端建得出来、调用编译得过、跑起来才 404）。
  registerPanelEventDeliveryRoutes(server, root.panel.eventFanout, root.target);
  const port = await server.listen(apiPort());

  // ── 面板 API 与客户鉴权 API ────────────────────────────────────────────────────
  // 两者都在**内部口监听之后**起：它们是对外面（console / 桌面客户端）的口，
  // 而内部口是本进程被其他服务调用的入口——先让被调面可达，外部口再上。
  // 起不来**不拖垮本进程**（沿用单体语义），但 MUST 具名说清是哪一条、为什么。
  let panelHandle: PanelHandle | null = null;
  if (root.panel.port === null) {
    console.warn('[aidcp-api] 面板 API 未启用（AIDCP_PANEL_PORT 未设）—— 管理后台将无后端');
  } else {
    panelHandle = await startPanelApi(root.panel.deps, {
      port: root.panel.port,
      jwtSecret: process.env.AIDCP_PANEL_JWT_SECRET ?? '',
      users: parsePanelUsers(process.env.AIDCP_PANEL_USERS),
      jwtTtlSeconds: Number(process.env.AIDCP_PANEL_JWT_TTL_SECONDS ?? 3600),
      // 自检名单：本进程自己的内部口 + PG + 客户鉴权口。**两个对外口互相回避**，
      // 撞上即拒绝绑定，而不是把另一条服务顶掉。
      forbiddenPorts: [
        port,
        5432,
        ...(root.clientAuth.port ? [root.clientAuth.port] : []),
        ...parseForbiddenPorts(process.env.AIDCP_PANEL_FORBIDDEN_PORTS),
      ],
      logger: console,
    });
    if (!panelHandle.started) {
      console.error(
        `[aidcp-api] 面板 API 启动失败（reason=${panelHandle.reason ?? 'unknown'}`
          + `${panelHandle.detail ? `, detail=${panelHandle.detail}` : ''}）—— 管理后台将无后端`,
      );
    } else {
      console.log(`[aidcp-api] 面板 API 已监听 127.0.0.1:${panelHandle.port}`);
    }
  }
  let clientAuthHandle: ClientAuthHandle | null = null;
  if (root.clientAuth.port === null) {
    console.warn(
      '[aidcp-api] 客户鉴权 API 未启用（AIDCP_CLIENT_AUTH_PORT 未设）—— 桌面客户端将无法登录',
    );
  } else {
    clientAuthHandle = await startClientAuthApi(root.clientAuth.deps, {
      port: root.clientAuth.port,
      jwtSecret: process.env.AIDCP_CLIENT_JWT_SECRET ?? '',
      // 只为那条「与面板密钥相同即拒启」的断言而传：密钥即边界，两边同一把等于边界坍塌。
      panelJwtSecret: process.env.AIDCP_PANEL_JWT_SECRET ?? '',
      jwtTtlSeconds: Number(process.env.AIDCP_CLIENT_JWT_TTL_SECONDS ?? 900),
      forbiddenPorts: [
        port,
        5432,
        ...(root.panel.port ? [root.panel.port] : []),
        ...parseForbiddenPorts(process.env.AIDCP_PANEL_FORBIDDEN_PORTS),
      ],
      logger: console,
    });
    if (!clientAuthHandle.started) {
      console.error(
        `[aidcp-api] 客户鉴权 API 启动失败（reason=${clientAuthHandle.reason ?? 'unknown'}`
          + `${clientAuthHandle.detail ? `, detail=${clientAuthHandle.detail}` : ''}）`
          + ' —— 桌面客户端将无法登录',
      );
    } else {
      console.log(`[aidcp-api] 客户鉴权 API 已监听 127.0.0.1:${clientAuthHandle.port}`);
    }
  }

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
        // 内容排期心跳与业务入口同起：它是业务工作，就绪闸没放行之前不该到点触发任何东西。
        // **依赖不可达不是启动闸**——跨进程那几跳问不到时由逐条失败方向处置（整轮跳过 / 跳过该账号 /
        // 判为在跑），MUST NOT 因此拒绝启动，否则自动化服务晚起一会就永远没人来处理排期。
        root.contentScheduler.start();
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
      root.contentScheduler.stop();
      if (publishApprovalRelayTimer) {
        clearInterval(publishApprovalRelayTimer);
        publishApprovalRelayTimer = null;
      }
      // 两个对外口先关：关停期间它们还开着，就等于对 console / 客户端继续声称「我在服务」。
      if (clientAuthHandle?.started) await clientAuthHandle.close().catch(() => undefined);
      if (panelHandle?.started) await panelHandle.close().catch(() => undefined);
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
  // 能力清单：注册了什么与没注册什么由**同一个数组**得出（见 formatApiCapabilityRoster）。
  // ⚠️ 这张清单是**人工维护**的，它不是从「实际注册了什么」推出来的。
  // 2026-08-04 实测过它撒谎的样子：七族路由一条都没注册，而这里照样打「未注册=无」。
  // 真正防漏的是路由清单闸（test/acceptance/served-route-inventory.test.ts，两个方向都锁）；
  // 本清单只负责把结论说给运行期的人听，**新增一族路由 MUST 同时在这里加一行**。
  const capabilities: ApiStartupCapability[] = [
    { name: 'api-owner-authorities', registered: true },
    { name: 'publish-approval-authorities', registered: true },
    { name: 'sync-read(snapshot/changed/readiness)', registered: true },
    { name: 'content-reads(role-model/provider-secret/image-model)', registered: true },
    { name: 'content-ports(review-card/publish-log/pipeline-log/publish-card-exit)', registered: true },
    { name: 'config-mirror-bump(落地端；生产方尚未接线)', registered: true },
    root.contentReads.accountPlatform
      ? { name: 'account-platform', registered: true }
      : {
          name: 'account-platform',
          registered: false,
          reason: '账号存储没有该方法 ⇒ 内容进程的账号平台判定会失败',
        },
    root.contentScheduler.scheduler === null
      ? {
          name: 'content-scheduling',
          registered: false,
          // 「没构造出来」与「构造了但还没放行」是两件事，前者是配置问题、要人去修。
          reason: '部署目标非法 ⇒ 调度器未构造；排期心跳在本进程永不推进',
        }
      : { name: 'content-scheduling', registered: true },
  ];
  console.log(
    `[aidcp-api] API owner listener active on 127.0.0.1:${port} `
      + `(target=${root.target}; schema 门=${options.schemaGate.mode}/`
      + `${options.schemaGate.pass ? '通过' : '未通过'}; `
      + `${formatApiCapabilityRoster(capabilities)}; `
      + `sync-read readiness=${root.syncRead.consumer.readiness().state}; `
      + `content scheduler=${
        root.contentScheduler.scheduler === null
          ? 'not constructed (deployment target invalid)'
          : businessIngressStarted
            ? 'running'
            : 'constructed, waiting for business ingress'
      }; `
      + `business ingress=${businessIngressStarted ? 'started' : 'blocked'})`,
  );
  return {
    port,
    readiness: () => root.syncRead.consumer.readiness(),
    close: stopService,
  };
}

// 可执行入口在 `src/api-service-entry.ts`，**不在本文件**。
//
// 本文件此前靠 `import.meta.url === pathToFileURL(process.argv[1]).href` 自举，且失败时只设
// `process.exitCode`、不真退出 —— 组装根在 try/catch 之外被裸 await ⇒ 已建的池永不 `end()`
// ⇒ 进程很可能压根不退出，systemd 看到的是 `active (running)` 的僵尸：既不服务，也不重启。
// 三个进程的启动外壳因此统一到一种形态（读配置 → 门 → 建根 → 先监听 → 就绪闸 → 放行业务 →
// 优雅关停 → 信号），入口独立成文件是那条形态的一部分。
