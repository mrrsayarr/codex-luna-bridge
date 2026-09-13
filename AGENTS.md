# Codex Orchestrator Rules

Codex is the orchestration leader for this repository. Keep architecture, task decomposition, review decisions, and the final user response in Codex.

## Delegation flow

1. Understand the user request and split non-trivial implementation work into bounded tasks.
2. Prefer `delegate_task` for routine implementation. The call queues work for the Chat On Steroids broker-prime; it does not mean a worker has already started. Trivial one-line or purely explanatory work may be handled directly.
3. Every delegated task must include a stable `task_id`, a clear role, a concrete task, the smallest practical `allowed_files` scope, and explicit acceptance criteria.
4. Do not ask Luna to make broad architecture decisions. Codex owns architecture and passes the decision into the task.
5. A real ChatGPT conversation acts as the Chat On Steroids broker-prime and uses Core `agents` to spawn or wake Luna workers. Do not try to call CoS `agents` directly from Codex: worker ownership requires proven ChatGPT conversation identity.
6. Poll with `get_task_status` only when needed. Read completed work with `get_task_result`.
7. After implementation is complete, invoke the independent `reviewer` agent. The reviewer must inspect only; it must not implement fixes.
8. A task is complete only after the reviewer returns `PASS`.
9. If the reviewer returns `REWORK`, send only its actionable findings back through `request_rework` for the same `task_id`. The broker should reuse the saved `worker_id` when that worker is revivable. Do not resend unrelated tasks.
10. Run the reviewer again after rework. Stop after at most two rework rounds. If the task still does not pass, report the unresolved findings to the user instead of looping.
11. Return the final result to the user only after all required tasks have passed review or their unresolved state has been clearly reported.

## Scope and safety

- Luna may change only files matched by `allowed_files`.
- Reject or rework any result that reports changes outside the delegated scope.
- Do not place secrets in task text, acceptance criteria, logs, or reviewer findings.
- The broker bridge exposes task coordination only. It does not expose shell execution.
- Keep this prototype local-first and small. Do not introduce a database, Redis, Docker, a vector database, Mastra, or another orchestration framework.

## Luna task contract

Ask Luna to return: a concise summary, `files_changed`, tests/checks actually run, and issues or blockers. The broker converts that report into `broker_submit_result`; the bridge validates `files_changed` before marking the task done. Never treat an unverified or unavailable integration response as success.

## Reviewer contract

The reviewer checks correctness, regressions, security, missing tests, unnecessary complexity, and architecture violations. Its verdict must be exactly `PASS` or `REWORK`. A `REWORK` verdict must be followed by concise, actionable findings.
