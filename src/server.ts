import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { buildWorkerPrompt, startBrokerHttpServer } from "./broker.js";
import { loadConfig } from "./config.js";
import { TaskStore } from "./tasks.js";
import type { DelegatedTaskRequest, TaskRecord, TaskResult } from "./types.js";

const TASK_ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, underscore or dash");
const ROLE = z.string().min(1).max(64);
const TASK_TEXT = z.string().min(1).max(20_000);
const PATH_PATTERN = z.string().min(1).max(512);
const CRITERION = z.string().min(1).max(2_000);
const FINDING = z.string().min(1).max(4_000);

function toolJson(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new TaskStore(config.taskStatePath);
  await store.initialize();
  await startBrokerHttpServer(config, store);

  const server = new McpServer({
    name: "codex-luna-bridge",
    version: "0.2.0",
  });

  server.tool(
    "delegate_task",
    "Delegate one bounded implementation task to the Chat On Steroids / Luna worker flow.",
    {
      task_id: TASK_ID,
      role: ROLE,
      task: TASK_TEXT,
      allowed_files: z.array(PATH_PATTERN).min(1).max(100),
      acceptance_criteria: z.array(CRITERION).min(1).max(50),
    },
    async (input) => {
      let record: TaskRecord | null = null;
      try {
        const request: DelegatedTaskRequest = input;
        record = await store.createTask(request);
        buildWorkerPrompt(record);
        return toolJson({
          task_id: record.task_id,
          status: record.status,
          broker: `http://127.0.0.1:${config.brokerPort}${config.brokerPath}`,
        });
      } catch (error) {
        if (record !== null) {
          record = await store.failTask(record.task_id, error);
        }
        return toolJson({
          task_id: record?.task_id ?? input.task_id,
          status: record?.status ?? "failed",
          error: errorMessage(error),
        }, true);
      }
    },
  );

  server.tool(
    "get_task_status",
    "Return the current status of a delegated task.",
    { task_id: TASK_ID },
    async ({ task_id }) => {
      try {
        const task = store.requireTask(task_id);
        return toolJson({
          task_id,
          status: task.status,
          worker_id: task.worker_id,
          rework_count: task.rework_count,
          last_error: task.last_error,
        });
      } catch (error) {
        return toolJson({ task_id, error: errorMessage(error) }, true);
      }
    },
  );

  server.tool(
    "get_task_result",
    "Return the result payload for a completed task.",
    { task_id: TASK_ID },
    async ({ task_id }) => {
      try {
        const task = store.requireTask(task_id);
        if (task.status !== "done" || task.result === null) {
          const unavailable: TaskResult = {
            summary: "",
            files_changed: [],
            tests: [],
            issues: [task.last_error ?? `Result unavailable while task status is ${task.status}`],
          };
          return toolJson(unavailable, true);
        }
        return toolJson(task.result);
      } catch (error) {
        const unavailable: TaskResult = {
          summary: "",
          files_changed: [],
          tests: [],
          issues: [errorMessage(error)],
        };
        return toolJson(unavailable, true);
      }
    },
  );

  server.tool(
    "request_rework",
    "Send actionable reviewer findings back through the same worker task flow.",
    {
      task_id: TASK_ID,
      findings: z.array(FINDING).min(1).max(50),
    },
    async ({ task_id, findings }) => {
      try {
        const current = store.requireTask(task_id);
        if (current.status === "queued" || current.status === "running") {
          throw new Error(`Task ${task_id} is still active and cannot be reworked yet`);
        }

        let task = await store.startRework(task_id, findings, config.maxReworkRounds);
        try {
          buildWorkerPrompt(task);
        } catch (error) {
          task = await store.failTask(task_id, error);
          throw error;
        }

        return toolJson({ task_id, status: task.status, rework_count: task.rework_count });
      } catch (error) {
        return toolJson({ task_id, error: errorMessage(error) }, true);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(JSON.stringify({ component: "codex-mcp", status: "started", transport: "stdio" }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ component: "mcp-server", status: "fatal", error: errorMessage(error) }));
  process.exitCode = 1;
});
