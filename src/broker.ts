import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import { TaskStore, validateTaskResultScope } from "./tasks.js";
import type { TaskRecord, TaskResult } from "./types.js";

const TASK_ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, underscore or dash");
const WORKER_ID = z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, underscore or dash");
const RESULT_TEXT = z.string().max(20_000);
const RESULT_ITEM = z.string().max(4_000);
const ERROR_TEXT = z.string().min(1).max(4_000);
const MAX_HTTP_BODY_BYTES = 256 * 1024;
const MAX_WORKER_PROMPT_CHARS = 3_900;

function toolJson(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function buildWorkerPrompt(task: TaskRecord): string {
  const rework = task.rework_count > 0
    ? `\nReviewer findings to fix in this round:\n${bulletList(task.last_findings)}\n`
    : "";
  const prompt = `You are the bounded implementation worker for task ${task.task_id}.

Role: ${task.role}
Task:
${task.task}

Allowed files/globs only:
${bulletList(task.allowed_files)}

Acceptance criteria:
${bulletList(task.acceptance_criteria)}
${rework}
Implement the task in the shared workspace. Do not make architecture decisions or touch files outside the allowed scope. Run only checks needed for this task.

When finished, report to the prime with agents action=finish. Use exactly these four sections and keep them factual:
RESULT
CHANGES
VALIDATION
BLOCKERS`;

  if (prompt.length > MAX_WORKER_PROMPT_CHARS) {
    throw new Error(
      `Task ${task.task_id} expands to ${prompt.length} worker-prompt characters; Chat On Steroids workers accept about 4000. Split this delegation into a smaller bounded task.`,
    );
  }
  return prompt;
}

function brokerTask(task: TaskRecord) {
  const workerPrompt = buildWorkerPrompt(task);
  return {
    task_id: task.task_id,
    mode: task.worker_id === null ? "spawn" : "message",
    worker_id: task.worker_id,
    role: task.role,
    rework_count: task.rework_count,
    worker_prompt: workerPrompt,
    next_step: task.worker_id === null
      ? "Call Chat On Steroids Core agents action=spawn with exactly one worker using worker_prompt as its task. Then call broker_start_task with the returned worker id."
      : `Call Chat On Steroids Core agents action=message to ${task.worker_id} using worker_prompt. Then call broker_start_task with the same worker id.`,
  };
}

function createBrokerMcpServer(store: TaskStore): McpServer {
  const server = new McpServer({
    name: "codex-luna-broker",
    version: "0.2.0",
  });

  server.tool(
    "broker_next_task",
    "Return the next queued Codex delegation. This broker must coordinate only: dispatch the returned worker_prompt through Chat On Steroids Core `agents`, never implement the task itself. If mode=spawn use agents action=spawn; if mode=message wake/reuse worker_id with agents action=message.",
    {},
    async () => {
      try {
        const task = store.nextQueuedTask();
        return toolJson({ task: task ? brokerTask(task) : null });
      } catch (error) {
        return toolJson({ error: errorMessage(error) }, true);
      }
    },
  );

  server.tool(
    "broker_start_task",
    "Mark a queued task running after Chat On Steroids accepted the worker spawn/message. Persist the actual worker id so reviewer rework can reuse the same Luna conversation.",
    { task_id: TASK_ID, worker_id: WORKER_ID },
    async ({ task_id, worker_id }) => {
      try {
        const task = await store.markRunning(task_id, worker_id);
        return toolJson({ task_id, status: task.status, worker_id: task.worker_id, rework_count: task.rework_count });
      } catch (error) {
        return toolJson({ task_id, error: errorMessage(error) }, true);
      }
    },
  );

  server.tool(
    "broker_submit_result",
    "Store the structured result after the Luna worker reports to the broker prime. files_changed is checked against Codex's allowed_files before the task can become done.",
    {
      task_id: TASK_ID,
      summary: RESULT_TEXT,
      files_changed: z.array(RESULT_ITEM).max(100),
      tests: z.array(RESULT_ITEM).max(100),
      issues: z.array(RESULT_ITEM).max(100),
    },
    async ({ task_id, summary, files_changed, tests, issues }) => {
      try {
        const task = store.requireTask(task_id);
        const result: TaskResult = validateTaskResultScope(task, { summary, files_changed, tests, issues });
        const completed = await store.setResult(task_id, result);
        return toolJson({ task_id, status: completed.status, worker_id: completed.worker_id });
      } catch (error) {
        return toolJson({ task_id, error: errorMessage(error) }, true);
      }
    },
  );

  server.tool(
    "broker_fail_task",
    "Mark a delegated task failed when the real worker could not be opened, resumed, or completed. Never synthesize a successful Luna result.",
    { task_id: TASK_ID, error: ERROR_TEXT },
    async ({ task_id, error }) => {
      try {
        const failed = await store.failTask(task_id, error);
        return toolJson({ task_id, status: failed.status, error: failed.last_error });
      } catch (cause) {
        return toolJson({ task_id, error: errorMessage(cause) }, true);
      }
    },
  );

  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_HTTP_BODY_BYTES) {
      throw new Error(`MCP request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function jsonResponse(res: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function hostIsLoopback(req: IncomingMessage): boolean {
  const host = req.headers.host?.trim().toLowerCase() ?? "";
  return host === "localhost" || host.startsWith("localhost:") || host === "127.0.0.1" || host.startsWith("127.0.0.1:");
}

export async function startBrokerHttpServer(config: AppConfig, store: TaskStore): Promise<HttpServer> {
  const httpServer = createServer(async (req, res) => {
    if (!hostIsLoopback(req)) {
      jsonResponse(res, 403, { error: "loopback_host_required" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { status: "ok", component: "codex-luna-broker" });
      return;
    }
    if (url.pathname !== config.brokerPath) {
      jsonResponse(res, 404, { error: "not_found" });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      jsonResponse(res, 405, { error: "method_not_allowed" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const mcp = createBrokerMcpServer(store);
    try {
      const body = await readJsonBody(req);
      // SDK 1.17.x's Node transport class and Transport interface disagree under
      // exactOptionalPropertyTypes even though they are the matching runtime pair.
      await mcp.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        jsonResponse(res, errorMessage(error).includes("exceeds") ? 413 : 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: errorMessage(error) },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(config.brokerPort, "127.0.0.1", () => {
      httpServer.off("error", onError);
      resolve();
    });
  });
  httpServer.unref();

  console.error(JSON.stringify({
    component: "broker-mcp",
    status: "started",
    url: `http://127.0.0.1:${config.brokerPort}${config.brokerPath}`,
  }));
  return httpServer;
}
