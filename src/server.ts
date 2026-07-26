import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseDeploymentTarget, type DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
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
import type { PersonaGeneratorPort } from 'aidcp-kernel/kernel/persona-ports.js';
import type { ScheduledAutomationCatalogReader } from 'aidcp-kernel/kernel/platform-types.js';
import { resolveOwnerPgConfig } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';
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
import {
  InternalHttpClient,
  InternalHttpServer,
} from 'aidcp-transport/transport/internal-http.js';
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
import { FacebookCommentConfigStore } from './config/facebook-comment-config-store.js';
import { createPersonaPanel } from './config/persona-facade.js';
import { PersonaStore } from './config/persona-store.js';
import type { ApiFeishuOwner } from './feishu/api-owner-composition.js';
import { PgInteractionAuthGate } from './interactions/interaction-auth-gate.js';
import { PgInteractionApiWrites } from './interactions/interaction-api-writes.js';
import { ReplyConfigResolver } from './interactions/reply-config-resolver.js';
import { ReplyConfigScopeStore } from './interactions/reply-config-scope-store.js';
import { FirstPostOnboardingStore } from './onboarding/first-post-onboarding-store.js';
import { PublishLogStore } from './publish-agent/publish-log-store.js';
import { createPublishUiUpdateProducer } from './publish-agent/publish-ui-update-producer.js';

const DEFAULT_API_PORT = 8094;

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

interface ApiCompositionRoot {
  target: DeploymentTarget;
  pool: pg.Pool;
  authorities: ApiDirectAuthorities;
  apiFeishu: ApiFeishuOwner;
  pairedCommands: {
    edgeResume: EdgeResumeCommandPort;
    facebookScope: FacebookScopeCommandPort;
    publishUi: PublishUiUpdateCommandPort;
    personaGenerator: PersonaGeneratorAuthorityPort;
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

const unavailableScheduledCatalog: ScheduledAutomationCatalogReader = {
  normalizeForCatalog(platform) {
    return String(platform ?? '').trim();
  },
  availableActions() {
    throw new Error('scheduled_automation_catalog_unavailable_in_api_service');
  },
  declarationsFor() {
    throw new Error('scheduled_automation_catalog_unavailable_in_api_service');
  },
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
    scheduledAutomationCatalog: unavailableScheduledCatalog,
  });
  const facebookCommentConfig = new FacebookCommentConfigStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
  });
  const personaStore = new PersonaStore({
    pool,
    schemaEnsurer: migrationManagedSchema,
  });
  const replyScopes = new ReplyConfigScopeStore({ pool });

  await Promise.all([
    accountStore.init(),
    publishLogStore.init(),
    clientUserStore.init(),
    approvalPolicy.init(),
    notificationContacts.init(),
    firstPostProgress.init(),
    contentSchedule.init(),
    facebookCommentConfig.init(),
    personaStore.init(),
    replyScopes.init(),
  ]);
  const accountState = new AccountStateManager(accountStore);
  await accountState.init();

  const pairedCommands = {
    edgeResume: new EdgeResumeCommandHttpClient(automationHttp, automationToken, target),
    facebookScope: new FacebookScopeCommandHttpClient(automationHttp, automationToken, target),
    publishUi: new PublishUiUpdateCommandHttpClient(automationHttp, automationToken, target),
    personaGenerator: new PersonaGeneratorCommandHttpClient(contentHttp, contentToken, target),
  };

  const { createApiFeishuOwner } = await import('./feishu/api-owner-composition.js');
  const apiFeishu = createApiFeishuOwner({
    pool,
    accountStore,
    accountDisplayName: (accountId) => accountStore.getDisplayName(accountId).name,
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
    dispatchActive: () => false,
    managementChatIds,
    logger: console,
  });
  await apiFeishu.startIngress({
    commandFace,
    writeApproval: async () => {
      throw new Error('publish_approval_writer_unavailable_in_api_service');
    },
  });

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

  const publishLog: AutomationPublishLogPort = {
    loadForDispatch: (recordId) => publishLogStore.loadForDispatch(recordId),
    updateStatus: (recordId, status) => publishLogStore.updateStatus(recordId, status),
    updatePostId: (recordId, postId, postUrl) =>
      publishLogStore.updatePostId(recordId, postId, postUrl),
    markScheduled: (recordId, scheduledAt, scheduledPlatformId) =>
      publishLogStore.markScheduled(recordId, scheduledAt, scheduledPlatformId),
    markImagesAttached: (recordId, imageCount) =>
      publishLogStore.markImagesAttached(recordId, imageCount),
    listDueScheduled: (limit, now) => publishLogStore.listDueScheduled(limit, now),
    deferScheduledReconcile: (recordId, error, nextAt, maxAttempts) =>
      publishLogStore.deferScheduledReconcile(recordId, error, nextAt, maxAttempts),
    confirmScheduledPublished: (recordId, postId, postUrl) =>
      publishLogStore.confirmScheduledPublished(recordId, postId, postUrl),
    getMostRecentPublishTime: () => publishLogStore.getMostRecentPublishTime(),
    recentPublishedContents: (limit) => publishLogStore.recentPublishedContents(limit),
    editDraft: async (recordId, expectedVersion, patch, editor, expectedAccountId) => {
      const result = await publishLogStore.editDraft(
        recordId,
        expectedVersion,
        patch,
        editor,
        expectedAccountId,
      );
      if (result.ok) {
        void publishUi.pushPreview(recordId).catch((error) => {
          console.warn(
            `[aidcp-api] draft committed; UI preview delivery failed record=${recordId}: `
              + `${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return result;
    },
    rejectPendingApproval: async (recordId) => {
      const draft = await publishLogStore.loadForDispatch(recordId);
      const rejected = await publishLogStore.rejectPendingApproval(recordId);
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
            console.warn(
              `[aidcp-api] rejection committed; UI state delivery failed record=${recordId}: `
                + `${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      return rejected;
    },
    pendingApprovalForAccount: (accountId) =>
      publishLogStore.pendingApprovalForAccount(accountId),
    pendingPublishPreviewForAccount: (accountId) =>
      publishLogStore.pendingPublishPreviewForAccount(accountId),
    lastPublishedForAccount: (accountId) =>
      publishLogStore.lastPublishedForAccount(accountId),
    countPendingForAccount: (accountId) =>
      publishLogStore.countPendingForAccount(accountId),
    countPendingAutonomousForAccount: (accountId) =>
      publishLogStore.countPendingAutonomousForAccount(accountId),
    countPublishedTodayForAccount: (accountId) =>
      publishLogStore.countPublishedTodayForAccount(accountId),
    countPublishedSinceForAccount: (accountId, since) =>
      publishLogStore.countPublishedSinceForAccount(accountId, since),
  };

  const edgePublish: EdgePublishCommandPort = {
    removeDraftImage: async () => {
      throw new Error('edge_publish_image_remove_handler_unavailable_in_api_service');
    },
    decidePublishApproval: async () => {
      throw new Error('edge_publish_approval_handler_unavailable_in_api_service');
    },
  };

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

  return { target, pool, authorities, apiFeishu, pairedCommands };
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
  registerNotificationContactsRoutes(server, port.notificationContacts, token, target);
  registerFirstPostProgressRoutes(server, port.firstPostProgress, token, target);
  registerAutomationConfigCommandsRoutes(server, port.automationConfigCommands, token, target);
  registerOffboardAdmissionLedgerRoutes(server, port.offboardAdmissionLedger, token, target);
  registerStructuredNotificationRoutes(server, port.notificationDelivery, token, target);
}

export async function startApiService(): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const root = await buildApiCompositionRoot();
  const server = new InternalHttpServer();
  registerApiAuthorityRoutes(server, root);
  const port = await server.listen(apiPort());
  console.log(
    `[aidcp-api] API owner composition ready on 127.0.0.1:${port} `
      + `(target=${root.target}; 16 owner route groups; 4 paired command clients)`,
  );
  return {
    port,
    async close() {
      await server.close();
      await root.pool.end();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApiService().catch((error) => {
    console.error('[aidcp-api] startup failed:', error);
    process.exitCode = 1;
  });
}
