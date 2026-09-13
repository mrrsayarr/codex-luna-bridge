---
name: codex-luna-orchestrator
description: Lead bounded implementation through the project codex-luna-bridge, a Chat On Steroids broker-prime, Luna workers, and independent Codex review.
---

# Codex Luna Orchestrator

Use this workflow for non-trivial coding work when the project-scoped `codex_luna_bridge` MCP server is available. The bridge is registered by the repository's `.codex/config.toml`; this skill intentionally does not bundle a second MCP registration.

1. Keep architecture decisions, decomposition, scope decisions, review coordination, and the final response in Codex.
2. For each routine implementation task, call `delegate_task` with a stable `task_id`, role, bounded task, smallest practical `allowed_files`, and concrete acceptance criteria. The call queues work; it does not pretend that Luna has already started.
3. A real ChatGPT conversation running as the Chat On Steroids broker-prime drains the queue through the loopback broker MCP surface and dispatches the task with the Core `agents` tool. Codex does not call CoS `agents` directly because that tool requires proven ChatGPT conversation identity.
4. Poll `get_task_status` only when useful. Read completed work through `get_task_result`.
5. Treat a failed or unavailable broker/worker integration as a blocker. Never invent a Luna result.
6. Compare every returned `files_changed` item against `allowed_files`. The bridge also enforces this check before accepting a result.
7. Use the configured read-only `reviewer` agent after a successful implementation result. Its verdict must be exactly `PASS` or `REWORK`.
8. On `REWORK`, send only the reviewer findings back with `request_rework` for the same task. The broker reuses the recorded `worker_id` through `agents action=message` when that worker is revivable. Review again after the result returns.
9. Stop after two rework rounds. Report unresolved findings instead of looping.

The broker-prime coordinates only; it must not implement delegated code itself. Luna may not make architecture decisions or write outside `allowed_files`. Keep task state in `.runtime/tasks.json`; do not add databases, Docker, Redis, vector stores, or orchestration frameworks.
