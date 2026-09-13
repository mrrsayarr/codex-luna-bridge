import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DelegatedTaskRequest, TaskRecord, TaskResult, TaskStatus } from "./types.js";

type TaskMutation = (task: TaskRecord) => TaskRecord;

function nowIso(): string {
  return new Date().toISOString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

export function validateAllowedFiles(patterns: string[]): string[] {
  if (patterns.length === 0) {
    throw new Error("allowed_files must contain at least one path or glob");
  }
  return patterns.map((rawPattern) => {
    const pattern = rawPattern.trim().replaceAll(String.fromCharCode(92), "/");
    if (!pattern || pattern.includes("\0")) {
      throw new Error(`Invalid allowed_files entry: ${JSON.stringify(rawPattern)}`);
    }

    if (path.posix.isAbsolute(pattern) || /^[A-Za-z]:\//.test(pattern) || pattern.startsWith("//")) {
      throw new Error(`Absolute paths are not allowed: ${rawPattern}`);
    }

    const segments = pattern.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error(`Path traversal is not allowed: ${rawPattern}`);
    }

    return pattern;
  });
}

export class TaskScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskScopeViolationError";
  }
}

function globMatches(pattern: string, filePath: string): boolean {
  let expression = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }

  return new RegExp(`${expression}$`).test(filePath);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Reject worker-reported file changes that exceed the task's declared scope. */
export function validateTaskResultScope(task: TaskRecord, value: unknown): TaskResult {
  if (typeof value !== "object" || value === null) {
    throw new TaskScopeViolationError("Worker returned an invalid task result");
  }

  const result = value as Partial<TaskResult>;
  if (
    typeof result.summary !== "string" ||
    !isStringArray(result.files_changed) ||
    !isStringArray(result.tests) ||
    !isStringArray(result.issues)
  ) {
    throw new TaskScopeViolationError("Worker returned an invalid task result shape");
  }

  const summary = result.summary as string;
  const filesChangedInput = result.files_changed as string[];
  const tests = result.tests as string[];
  const issues = result.issues as string[];
  const filesChanged = filesChangedInput.map((file) => {
    const normalized = validateAllowedFiles([file])[0]!;
    if (/[?*\[\]{}]/.test(normalized)) {
      throw new TaskScopeViolationError(`files_changed must contain concrete paths: ${file}`);
    }
    if (!task.allowed_files.some((pattern) => globMatches(pattern, normalized))) {
      throw new TaskScopeViolationError(`Worker reported a file outside allowed_files: ${normalized}`);
    }
    return normalized;
  });

  return {
    summary,
    files_changed: filesChanged,
    tests,
    issues,
  };
}

export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly statePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });

    try {
      const raw = await readFile(this.statePath, "utf8");
      if (!raw.trim()) {
        return;
      }

      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("Task state file must contain a JSON array");
      }

      for (const item of parsed) {
        if (!this.isTaskRecord(item)) {
          throw new Error("Task state file contains an invalid task record");
        }
        this.tasks.set(item.task_id, { ...item, worker_id: item.worker_id ?? null });
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.persist();
        return;
      }
      throw error;
    }
  }

  async createTask(input: DelegatedTaskRequest): Promise<TaskRecord> {
    if (this.tasks.has(input.task_id)) {
      throw new Error(`Task already exists: ${input.task_id}`);
    }

    const timestamp = nowIso();
    const task: TaskRecord = {
      ...input,
      allowed_files: validateAllowedFiles(input.allowed_files),
      status: "queued",
      result: null,
      worker_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      rework_count: 0,
      last_error: null,
      last_findings: [],
    };

    this.tasks.set(task.task_id, task);
    await this.persist();
    this.logTask(task, "created");
    return structuredClone(task);
  }

  getTask(taskId: string): TaskRecord | null {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  requireTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  nextQueuedTask(): TaskRecord | null {
    const task = [...this.tasks.values()]
      .filter((candidate) => candidate.status === "queued")
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];
    return task ? structuredClone(task) : null;
  }

  async markRunning(taskId: string, workerId: string): Promise<TaskRecord> {
    return this.mutate(taskId, (task) => {
      if (task.status !== "queued") {
        throw new Error(`Task ${taskId} must be queued before it can start; current status is ${task.status}`);
      }

      return {
        ...task,
        status: "running",
        worker_id: workerId,
        updated_at: nowIso(),
        last_error: null,
      };
    });
  }

  async setStatus(taskId: string, status: TaskStatus): Promise<TaskRecord> {
    return this.mutate(taskId, (task) => ({
      ...task,
      status,
      updated_at: nowIso(),
      last_error: status === "failed" ? task.last_error : null,
    }));
  }

  async setResult(taskId: string, result: TaskResult): Promise<TaskRecord> {
    return this.mutate(taskId, (task) => {
      if (task.status !== "running") {
        throw new Error(`Task ${taskId} must be running before a result can be submitted; current status is ${task.status}`);
      }

      return {
        ...task,
        status: "done",
        result,
        updated_at: nowIso(),
        last_error: null,
      };
    });
  }

  async setLastError(taskId: string, message: string): Promise<TaskRecord> {
    return this.mutate(taskId, (task) => ({
      ...task,
      updated_at: nowIso(),
      last_error: message,
    }));
  }

  async failTask(taskId: string, error: unknown): Promise<TaskRecord> {
    const message = error instanceof Error ? error.message : String(error);
    return this.mutate(taskId, (task) => ({
      ...task,
      status: "failed",
      updated_at: nowIso(),
      last_error: message,
    }));
  }

  async startRework(taskId: string, findings: string[], maxRounds: number): Promise<TaskRecord> {
    return this.mutate(taskId, (task) => {
      if (task.rework_count >= maxRounds) {
        throw new Error(`Maximum rework rounds reached for ${taskId}: ${maxRounds}`);
      }

      return {
        ...task,
        status: "queued",
        result: null,
        updated_at: nowIso(),
        rework_count: task.rework_count + 1,
        last_error: null,
        last_findings: [...findings],
      };
    });
  }

  private async mutate(taskId: string, mutation: TaskMutation): Promise<TaskRecord> {
    const current = this.tasks.get(taskId);
    if (!current) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    const next = mutation(structuredClone(current));
    this.tasks.set(taskId, next);
    await this.persist();
    this.logTask(next, "updated");
    return structuredClone(next);
  }

  private async persist(): Promise<void> {
    const payload = `${JSON.stringify([...this.tasks.values()], null, 2)}\n`;
    this.persistChain = this.persistChain.then(() => writeFile(this.statePath, payload, { encoding: "utf8", mode: 0o600 }));
    await this.persistChain;
  }

  private logTask(task: TaskRecord, event: "created" | "updated"): void {
    console.error(JSON.stringify({
      component: "task-store",
      event,
      task_id: task.task_id,
      status: task.status,
      created_at: task.created_at,
      updated_at: task.updated_at,
      rework_count: task.rework_count,
      last_error: task.last_error,
    }));
  }

  private isTaskRecord(value: unknown): value is TaskRecord {
    if (typeof value !== "object" || value === null) {
      return false;
    }

    const candidate = value as Partial<TaskRecord>;
    return (
      typeof candidate.task_id === "string" &&
      typeof candidate.role === "string" &&
      typeof candidate.task === "string" &&
      Array.isArray(candidate.allowed_files) &&
      Array.isArray(candidate.acceptance_criteria) &&
      (candidate.status === "queued" || candidate.status === "running" || candidate.status === "done" || candidate.status === "failed") &&
      (candidate.worker_id === undefined || typeof candidate.worker_id === "string" || candidate.worker_id === null) &&
      typeof candidate.created_at === "string" &&
      typeof candidate.updated_at === "string" &&
      typeof candidate.rework_count === "number" &&
      (typeof candidate.last_error === "string" || candidate.last_error === null) &&
      Array.isArray(candidate.last_findings)
    );
  }
}
