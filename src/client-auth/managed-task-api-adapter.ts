/**
 * API-owned managed-task entry adapter.
 *
 * The caller supplies an already-authenticated actor context. This adapter re-checks the
 * customer/account scope from API-owned authorities, injects the deployment target and wire
 * contract, computes the canonical command hash, and calls the Automation command port.
 * It owns no Automation store and has no Edge fallback.
 */
import { createHash } from 'node:crypto';
import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import {
  MANAGED_TASK_CONTRACT,
  type CancelManagedTaskInput,
  type CancelManagedTaskResult,
  type CreateManagedTaskInput,
  type CreateManagedTaskResult,
  type ManagedTaskActor,
  type ManagedTaskCommandPort,
  type ManagedTaskEnvelope,
  type ManagedTaskJson,
  type ManagedTaskRejection,
  type QueryManagedTaskInput,
  type QueryManagedTaskResult,
} from 'aidcp-transport/transport/managed-task-http.js';
import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { AccountStore } from '../account-store.js';
import type { ClientUserStore } from './client-user-store.js';

export interface ManagedTaskApiRequestContext {
  /** Identity and auth-session revision produced by the caller's authenticated surface. */
  actor: ManagedTaskActor;
  correlationId: string;
  causationId: string | null;
}

export type ManagedTaskApiCreateRequest = ManagedTaskApiRequestContext
  & Omit<CreateManagedTaskInput, 'payloadHash'>;

export type ManagedTaskApiCancelRequest = ManagedTaskApiRequestContext
  & Omit<CancelManagedTaskInput, 'payloadHash'>;

export type ManagedTaskApiQueryRequest = ManagedTaskApiRequestContext
  & QueryManagedTaskInput;

export interface ManagedTaskAccountAuthorizationRequest {
  actor: ManagedTaskActor;
  accountId: string;
  envKey?: string;
  platform?: PlatformId;
}

export type ManagedTaskAccountAuthorizationResult =
  | { ok: true; authorizationRevision: string }
  | { ok: false; reason: 'not_authorized' | 'authorization_unavailable' };

/** Consumer-owned port: implementations read only API-owned identity/account authorities. */
export interface ManagedTaskAccountAuthorizationPort {
  authorize(
    request: ManagedTaskAccountAuthorizationRequest,
  ): Promise<ManagedTaskAccountAuthorizationResult>;
}

type ClientManagedTaskScopeStore = Pick<
  ClientUserStore,
  'isEnabled' | 'resolveBoundAccountForEnv' | 'isAccountReachableByUser'
>;

type ManagedTaskAccountPlatformReader = Pick<AccountStore, 'getPlatformOrNull'>;

export interface ClientUserManagedTaskAuthorizationOptions {
  clients: ClientManagedTaskScopeStore;
  accounts: ManagedTaskAccountPlatformReader;
}

function actorShapeIsValid(actor: ManagedTaskActor): boolean {
  return (actor.kind === 'customer' || actor.kind === 'operator' || actor.kind === 'agent')
    && actor.actorId.length > 0
    && actor.customerId.length > 0
    && actor.authorizationRevision.length > 0
    // A customer credential cannot claim a second actor identity. Operator/Agent identity
    // assignment is authenticated by their own outer surface, while customerId remains the
    // account-scope anchor checked below.
    && (actor.kind !== 'customer' || actor.actorId === actor.customerId);
}

/**
 * Current API authority implementation. It deliberately reuses the same forward/reverse
 * binding reads as customer-auth, including active ownership and cross-customer contention.
 */
export class ClientUserManagedTaskAuthorization implements ManagedTaskAccountAuthorizationPort {
  constructor(private readonly options: ClientUserManagedTaskAuthorizationOptions) {}

  async authorize(
    request: ManagedTaskAccountAuthorizationRequest,
  ): Promise<ManagedTaskAccountAuthorizationResult> {
    if (!actorShapeIsValid(request.actor) || request.accountId.length === 0) {
      return { ok: false, reason: 'not_authorized' };
    }

    try {
      const binding = request.envKey === undefined
        ? await this.options.clients.isAccountReachableByUser(
          request.actor.customerId,
          request.accountId,
        )
        : await this.options.clients.resolveBoundAccountForEnv(
          request.actor.customerId,
          request.envKey,
        );

      if (!binding.ok) {
        return binding.reason === 'binding_unavailable'
          ? { ok: false, reason: 'authorization_unavailable' }
          : { ok: false, reason: 'not_authorized' };
      }
      if (binding.accountId !== request.accountId) {
        return { ok: false, reason: 'not_authorized' };
      }
      if (!(await this.options.clients.isEnabled(request.actor.customerId))) {
        return { ok: false, reason: 'not_authorized' };
      }
      if (request.platform !== undefined) {
        const actualPlatform = await this.options.accounts.getPlatformOrNull?.(request.accountId);
        if (actualPlatform === null || actualPlatform === undefined || actualPlatform !== request.platform) {
          return { ok: false, reason: 'not_authorized' };
        }
      }

      return {
        ok: true,
        authorizationRevision: request.actor.authorizationRevision,
      };
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
  }
}

function canonicalize(value: ManagedTaskJson): ManagedTaskJson {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key]!)]),
  );
}

function payloadHash(value: ManagedTaskJson): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function actorJson(actor: ManagedTaskActor): ManagedTaskJson {
  return {
    kind: actor.kind,
    actorId: actor.actorId,
    customerId: actor.customerId,
    authorizationRevision: actor.authorizationRevision,
  };
}

/** Canonical API-side hash; a drift snapshot is pinned in the adapter tests. */
export function managedTaskCreatePayloadHash(
  input: Omit<CreateManagedTaskInput, 'payloadHash'>,
): string {
  return payloadHash({
    commandId: input.commandId,
    actor: actorJson(input.actor),
    accountId: input.accountId,
    envKey: input.envKey,
    platform: input.platform,
    taskDefinition: { id: input.taskDefinition.id, version: input.taskDefinition.version },
    parameters: input.parameters,
    capabilityScope: {
      allow: [...input.capabilityScope.allow],
      deny: [...input.capabilityScope.deny],
    },
    budget: {
      maxBrowserMinutes: input.budget.maxBrowserMinutes,
      maxSteps: input.budget.maxSteps,
      maxExecutionAttempts: input.budget.maxExecutionAttempts,
      maxWaitMs: input.budget.maxWaitMs,
    },
    schedule: {
      scheduledAt: input.schedule.scheduledAt,
      latestStartAt: input.schedule.latestStartAt,
      missPolicy: input.schedule.missPolicy,
    },
  });
}

/** Canonical API-side hash; a drift snapshot is pinned in the adapter tests. */
export function managedTaskCancelPayloadHash(
  input: Omit<CancelManagedTaskInput, 'payloadHash'>,
): string {
  return payloadHash({
    commandId: input.commandId,
    actor: actorJson(input.actor),
    accountId: input.accountId,
    taskId: input.taskId,
    expectedAggregateVersion: input.expectedAggregateVersion,
    reason: input.reason,
  });
}

function authorizationRejected(): ManagedTaskRejection {
  return {
    outcome: 'rejected',
    code: 'account_not_authorized',
    message: 'actor/account authorization is absent or stale',
  };
}

function envelope<T>(
  executionTarget: DeploymentTarget,
  context: ManagedTaskApiRequestContext,
  input: T,
): ManagedTaskEnvelope<T> {
  return {
    contract: MANAGED_TASK_CONTRACT,
    executionTarget,
    correlationId: context.correlationId,
    causationId: context.causationId,
    input,
  };
}

export interface ManagedTaskApiOwnerAdapterOptions {
  executionTarget: DeploymentTarget;
  authorization: ManagedTaskAccountAuthorizationPort;
  automation: ManagedTaskCommandPort;
}

/**
 * Owner-safe entry facade. Authorization denial never reaches Automation; query denial is
 * intentionally collapsed to not_found so task existence cannot cross customer boundaries.
 */
export class ManagedTaskApiOwnerAdapter {
  constructor(private readonly options: ManagedTaskApiOwnerAdapterOptions) {}

  async create(request: ManagedTaskApiCreateRequest): Promise<CreateManagedTaskResult> {
    const authorization = await this.options.authorization.authorize({
      actor: request.actor,
      accountId: request.accountId,
      envKey: request.envKey,
      platform: request.platform,
    });
    if (!authorization.ok) {
      return authorization.reason === 'authorization_unavailable'
        ? { outcome: 'unavailable', reason: 'managed_task_authorization_unavailable' }
        : authorizationRejected();
    }
    if (authorization.authorizationRevision !== request.actor.authorizationRevision) {
      return authorizationRejected();
    }

    const { correlationId, causationId, ...withoutContext } = request;
    const input: CreateManagedTaskInput = {
      ...withoutContext,
      payloadHash: managedTaskCreatePayloadHash(withoutContext),
    };
    return this.options.automation.create(envelope(
      this.options.executionTarget,
      { actor: request.actor, correlationId, causationId },
      input,
    ));
  }

  async cancel(request: ManagedTaskApiCancelRequest): Promise<CancelManagedTaskResult> {
    const authorization = await this.options.authorization.authorize({
      actor: request.actor,
      accountId: request.accountId,
    });
    if (!authorization.ok) {
      return authorization.reason === 'authorization_unavailable'
        ? { outcome: 'unavailable', reason: 'managed_task_authorization_unavailable' }
        : authorizationRejected();
    }
    if (authorization.authorizationRevision !== request.actor.authorizationRevision) {
      return authorizationRejected();
    }

    const { correlationId, causationId, ...withoutContext } = request;
    const input: CancelManagedTaskInput = {
      ...withoutContext,
      payloadHash: managedTaskCancelPayloadHash(withoutContext),
    };
    return this.options.automation.cancel(envelope(
      this.options.executionTarget,
      { actor: request.actor, correlationId, causationId },
      input,
    ));
  }

  async query(request: ManagedTaskApiQueryRequest): Promise<QueryManagedTaskResult> {
    const authorization = await this.options.authorization.authorize({
      actor: request.actor,
      accountId: request.accountId,
    });
    if (!authorization.ok || authorization.authorizationRevision !== request.actor.authorizationRevision) {
      return authorization.ok || authorization.reason !== 'authorization_unavailable'
        ? { outcome: 'not_found' }
        : { outcome: 'unavailable', reason: 'managed_task_authorization_unavailable' };
    }

    const { correlationId, causationId, ...input } = request;
    return this.options.automation.query(envelope(
      this.options.executionTarget,
      { actor: request.actor, correlationId, causationId },
      input,
    ));
  }
}
