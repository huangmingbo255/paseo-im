import type { PaseoApi } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import type { Connection, Target } from "../shared/config.ts";
import { UserFacingError } from "../shared/errors.ts";
import type { PaseoImTargetEntry } from "./bots-contract.ts";
import { refreshLinkedAgent } from "./agents.ts";
import type { StateStore } from "./state-store.ts";

export const CONNECTION_LABEL = "im/connection";
export const CONVERSATION_LABEL = "im/conversation";

export interface PrepareResult {
  agentId: string;
  context: string;
}

/** bots-contract/v1 target 注册表快照（无契约 = 空数组）。 */
export type ContractTargets = readonly PaseoImTargetEntry[];

/** 统一去向解析：显式会话绑定 > 连接默认去向 > 契约注册表回退。
 * 契约条目等效 {kind:'agent', agentId} target（不新增 target kind）；sharedHistory
 * 取 true：bots+ 主聊天按约定允许多个 IM 会话汇入同一 agent，不开共享会命中
 * 「已绑定其他 IM 会话」防护。返回 null 表示无任何去向（契约回退也不可用）。 */
export function resolveTarget(
  config: Connection,
  conversationKey: string,
  contractTargets?: ContractTargets,
): Target | null {
  const binding = (config.bindings as Record<string, Target | null>)[conversationKey];
  if (binding) return binding;
  if (config.target) return config.target;
  const entry = contractTargets?.[0];
  if (!entry) return null;
  return { kind: "agent", agentId: entry.agentId, sharedHistory: true };
}

/** Resolve the message destination and make sure a live agent exists for it. */
export class Router {
  private readonly daemon: () => Promise<PaseoApi>;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;
  private readonly contractTargets?: () => ContractTargets;

  constructor(
    daemon: () => Promise<PaseoApi>,
    log?: (level: "info" | "warn" | "error", message: string) => void,
    contractTargets?: () => ContractTargets,
  ) {
    this.daemon = daemon;
    this.log = log ?? (() => {});
    this.contractTargets = contractTargets;
  }

  private api(): Promise<PaseoApi> {
    return this.daemon();
  }

  private isRequestKeyConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /agent_request_key_conflict/i.test(message);
  }

  private isWorkspaceArchived(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /workspace is archived|workspace.*archiv/i.test(message);
  }

  targetFor(config: Connection, conversationKey: string): Target | null {
    const targets = this.contractTargets?.() ?? [];
    const target = resolveTarget(config, conversationKey, targets);
    const explicit =
      (config.bindings as Record<string, Target | null>)[conversationKey] ?? config.target;
    if (target && !explicit) {
      this.log("info", `[bots-contract] 会话 ${conversationKey} 无显式去向，按契约路由到 agent ${target.kind === "agent" ? target.agentId : "未知"}。`);
    }
    return target;
  }

  async prepare(
    config: Connection,
    state: StateStore,
    conversationKey: string,
    title: string,
  ): Promise<PrepareResult> {
    const api = await this.api();
    const target = this.targetFor(config, conversationKey);
    if (!target) {
      throw new UserFacingError("尚未配置消息去向：请在 Paseo → IM 中为该会话选择聊天或工作区。");
    }

    const known = state.get().conversations[conversationKey]?.agentId ?? null;
    let recreateSuffix = "";
    if (known) {
      const snapshot = await refreshLinkedAgent((await this.api()).agents.ref(known));
      if (snapshot && !snapshot.agent.archivedAt && snapshot.agent.status !== "closed") {
        return { agentId: known, context: "" };
      }
      // 已归档/关闭：按归档时间轮换幂等键，否则幂等创建会退回同一个死 agent
      const archivedAt = snapshot?.agent.archivedAt;
      recreateSuffix = archivedAt ? `-r${new Date(archivedAt).getTime()}` : "-r1";
      await state.mutate((draft) => {
        delete draft.conversations[conversationKey];
      });
    }

    if (target.kind === "agent") {
      if (!target.sharedHistory) {
        const reused = Object.entries(state.get().conversations).find(
          ([key, entry]) => entry.agentId === target.agentId && key !== conversationKey,
        );
        if (reused) {
          throw new UserFacingError(
            "该 Paseo 聊天已绑定其他 IM 会话。如需共享历史请在路由设置中显式开启，或另选聊天。",
          );
        }
      }
      const snapshot = await refreshLinkedAgent(api.agents.ref(target.agentId));
      if (!snapshot || snapshot.agent.archivedAt || snapshot.agent.status === "closed") {
        throw new UserFacingError("所选的 Paseo 聊天当前不可用（可能已归档）。");
      }
      await state.mutate((draft) => {
        draft.conversations[conversationKey] = {
          title: title || null,
          agentId: target.agentId,
          workspaceId: snapshot.agent.workspaceId ?? null,
          updatedAt: Date.now(),
        };
      });
      return { agentId: target.agentId, context: "" };
    }

    const workspace = api.workspaces.ref(target.workspaceId);
    const source = await workspace.refresh();
    if (!source || source.archivingAt) {
      throw new UserFacingError("所选工作区不可用（可能已归档）。");
    }
    const profile = target.profile;
    const buildPayload = (idempotencyKey: string) => ({
      idempotencyKey,
      config: {
        provider: profile.provider,
        ...(profile.modeId ? { modeId: profile.modeId } : {}),
        ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
        systemPrompt: profile.systemPrompt,
      },
      labels: { [CONNECTION_LABEL]: config.id, [CONVERSATION_LABEL]: conversationKey },
      title: `${config.name} · ${title || conversationKey}`,
    });

    const isAlive = (
      snap: { agent: { archivedAt?: string | null; status?: string | null } } | null | undefined,
    ) => Boolean(snap && !snap.agent.archivedAt && snap.agent.status !== "closed");

    // 首选幂等键创建。Paseo 的创建幂等记录可能长于 agent 生命周期，
    // 也可能保留一次失败请求；冲突时必须换键，否则同一群会永久失败。
    const stableKey = `im-agent-${config.id}-${conversationKey}${recreateSuffix}`;
    let agent;
    try {
      agent = await workspace.agents.create(buildPayload(stableKey));
    } catch (error) {
      if (this.isWorkspaceArchived(error)) {
        throw new UserFacingError("所选工作区已归档，请在 Paseo → IM 中重新选择一个活动工作区。");
      }
      if (!this.isRequestKeyConflict(error)) throw error;
      const retryKey = `im-agent-${config.id}-${conversationKey}-g${randomUUID()}`;
      this.log("warn", `创建会话 agent 的幂等键冲突，使用新键重试（conv=${conversationKey.slice(0, 40)}）`);
      try {
        agent = await workspace.agents.create(buildPayload(retryKey));
      } catch (retryError) {
        if (this.isWorkspaceArchived(retryError)) {
          throw new UserFacingError("所选工作区已归档，请在 Paseo → IM 中重新选择一个活动工作区。");
        }
        throw retryError;
      }
    }
    let created = await agent.refresh().catch(() => null);
    if (!isAlive(created)) {
      this.log("warn", `幂等创建返回了不可用实例（${agent.id.slice(0, 8)}，status=${created?.agent?.status ?? "null"}），换随机键重建`);
      const retry = await workspace.agents.create(buildPayload(`im-agent-${config.id}-${conversationKey}-g${randomUUID()}`));
      created = await retry.refresh().catch(() => null);
      if (!isAlive(created)) {
        throw new UserFacingError("无法在该工作区创建新的 IM 会话聊天（重复返回已归档实例），请检查工作区后重试。");
      }
      agent = retry;
    }
    const aliveId = agent.id;
    this.log("info", `会话 agent 就绪：${aliveId.slice(0, 8)} (conv=${conversationKey.slice(0, 40)})`);
    await state.mutate((draft) => {
      draft.conversations[conversationKey] = {
        title: title || null,
        agentId: aliveId,
        workspaceId: created?.agent.workspaceId ?? null,
        updatedAt: Date.now(),
      };
    });
    return { agentId: aliveId, context: "" };
  }
}

/** 改连接去向时迁移「跟随旧 agent」的会话绑定：agent→agent 整体改绑新 agent，
 * agent→workspace 解除绑定（会话回归默认去向重新派发）。不迁移手动绑到其他
 * agent 的会话——那些是用户显式的细粒度路由。 */
export function migrateConversationTargets(
  conversations: Record<string, { agentId: string | null }>,
  fromAgentId: string,
  next: Target | null,
): void {
  const nextAgentId = next?.kind === "agent" ? next.agentId : null;
  for (const conversation of Object.values(conversations)) {
    if (conversation.agentId !== fromAgentId) continue;
    conversation.agentId = nextAgentId;
  }
}

export function migrateBindingTargets(
  bindings: Record<string, Target>,
  fromAgentId: string,
  next: Target | null,
): Record<string, Target> {
  const nextAgentId = next?.kind === "agent" ? next.agentId : null;
  const migrated: Record<string, Target> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding?.kind === "agent" && binding.agentId === fromAgentId) {
      // 改到 workspace 时解除旧 agent 绑定，让该会话回归默认去向。
      if (nextAgentId === null) continue;
      migrated[key] = { ...binding, agentId: nextAgentId };
      continue;
    }
    migrated[key] = binding;
  }
  return migrated;
}
