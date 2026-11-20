import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { connectionSchema, emptyPolicy, type Connection } from "../shared/config.ts";
import { UserFacingError } from "../shared/errors.ts";
import { Router } from "../server/routing.ts";
import { StateStore } from "../server/state-store.ts";

const CONNECTION_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "workspace-1";

function connection(): Connection {
  return connectionSchema.parse({
    id: CONNECTION_ID,
    channel: "telegram",
    name: "测试连接",
    enabled: true,
    target: {
      kind: "workspace",
      workspaceId: WORKSPACE_ID,
      profile: { provider: "codex/model", systemPrompt: "" },
    },
    policy: emptyPolicy(),
    bindings: {},
    revision: 0,
    username: "paseo_bot",
    botUserId: "bot-1",
  }) as Connection;
}

function agent(id: string) {
  return {
    id,
    async refresh() {
      return { agent: { id, status: "idle", archivedAt: null, workspaceId: WORKSPACE_ID } };
    },
  };
}

async function withState<T>(run: (state: StateStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "paseo-im-routing-"));
  try {
    const state = new StateStore(CONNECTION_ID, root);
    await state.load();
    return await run(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("workspace agent creation retries with a new key after an idempotency conflict", async () => {
  await withState(async (state) => {
    const keys: string[] = [];
    let attempts = 0;
    const workspace = {
      async refresh() {
        return { id: WORKSPACE_ID, archivingAt: null };
      },
      agents: {
        async create(input: { idempotencyKey: string }) {
          keys.push(input.idempotencyKey);
          attempts += 1;
          if (attempts === 1) throw new Error("agent_request_key_conflict");
          return agent("agent-new");
        },
      },
    };
    const api = { workspaces: { ref: () => workspace } } as unknown as PaseoApi;
    const router = new Router(() => Promise.resolve(api));
    const result = await router.prepare(connection(), state, "group:chat-1", "群聊");

    assert.equal(result.agentId, "agent-new");
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(state.get().conversations["group:chat-1"]?.agentId, "agent-new");
  });
});

test("workspace agent creation reports archived workspace clearly", async () => {
  await withState(async (state) => {
    const workspace = {
      async refresh() {
        return { id: WORKSPACE_ID, archivingAt: null };
      },
      agents: {
        async create() {
          throw new Error("Plugin shared-browser agent.open.before failed: Workspace is archived: workspace-1");
        },
      },
    };
    const api = { workspaces: { ref: () => workspace } } as unknown as PaseoApi;
    const router = new Router(() => Promise.resolve(api));

    await assert.rejects(
      () => router.prepare(connection(), state, "group:chat-1", "群聊"),
      (error: unknown) => {
        assert.ok(error instanceof UserFacingError);
        assert.match(error.message, /工作区已归档/);
        return true;
      },
    );
  });
});
