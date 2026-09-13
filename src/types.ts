export const TASK_STATUSES = ["queued", "running", "done", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskResult {
  summary: string;
  files_changed: string[];
  tests: string[];
  issues: string[];
}

export interface DelegatedTaskRequest {
  task_id: string;
  role: string;
  task: string;
  allowed_files: string[];
  acceptance_criteria: string[];
}

export interface TaskRecord extends DelegatedTaskRequest {
  status: TaskStatus;
  result: TaskResult | null;
  worker_id: string | null;
  created_at: string;
  updated_at: string;
  rework_count: number;
  last_error: string | null;
  last_findings: string[];
}

export interface ReworkRequest {
  task_id: string;
  findings: string[];
}
