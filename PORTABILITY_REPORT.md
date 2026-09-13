# Codex + Chat On Steroids Agent System — Portability Report

## Short conclusion

This system is portable because the orchestration code itself is small and local-first. Moving it to another machine mainly requires copying the repository, rebuilding the Node bridge, and recreating the Chat On Steroids connection state.

The important non-portable part is the **ChatGPT / Chat On Steroids conversation identity**. A real ChatGPT conversation must act as the broker-prime because Chat On Steroids worker ownership depends on proven conversation attribution. Therefore a new environment needs a fresh CoS setup, companion extension, connectors, approved workspace, and broker-prime chat.

## Minimum architecture

```text
User
  -> Codex leader/reviewer
  -> local Node MCP bridge
  -> ChatGPT broker-prime with Chat On Steroids
  -> CoS agents spawn/message
  -> worker chat
  -> result back to Codex
```

No Redis, Docker, database, Mastra, or vector store is required.

## What must be copied

Copy the repository including at least:

- `src/`
- `.codex/config.toml`
- `.codex/agents/reviewer.toml`
- `AGENTS.md`
- `BROKER_PRIME.md`
- `package.json`
- `package-lock.json`
- `.env.example`

Do **not** treat `.runtime/tasks.json` as required migration state. It is local execution state and can normally start empty on a new environment.

## Prerequisites on the new machine

1. Node.js 20+ and npm.
2. Codex CLI or Desktop with project-scoped `.codex/config.toml` support.
3. Chat On Steroids installed and running.
4. The matching Chat On Steroids companion browser extension loaded and connected.
5. Chat On Steroids Core connected in ChatGPT and multi-agent mode enabled.
6. The project folder approved in Chat On Steroids so workers can read/write the workspace.
7. The Chat On Steroids Plugins connector configured if the local broker is exposed through the Plugins surface.

## Recommended setup order

### 1. Copy and build

```bash
npm install
npm run typecheck
npm run build
```

### 2. Start Codex from the project root

The repository `.codex/config.toml` launches:

```text
node dist/server.js
```

This process exposes two surfaces:

- Codex-facing stdio MCP tools
- broker MCP at `http://127.0.0.1:8788/mcp`

### 3. Configure Chat On Steroids

Approve the repository folder, enable Core tools and multi-agent mode, and ensure the browser extension matches the installed CoS version.

Add or recreate the remote MCP plugin:

```text
Name: Codex Luna Broker
URL:  http://127.0.0.1:8788/mcp
```

It should expose:

- `broker_next_task`
- `broker_start_task`
- `broker_submit_result`
- `broker_fail_task`

After plugin/tool changes, refresh the Chat On Steroids Plugins connector in ChatGPT if the tools are stale or missing.

### 4. Create a fresh broker-prime chat

Open a normal ChatGPT conversation with Chat On Steroids Core and the broker plugin connected. Paste the instructions from `BROKER_PRIME.md`.

This chat is transport-only. Codex remains architect, leader and reviewer.

### 5. Configure worker defaults

Set Chat On Steroids worker defaults to the desired worker model. The bridge intentionally does not hard-code a model id, which makes migration easier.

## Portability risks

### Conversation identity

This is the main platform dependency. Direct `Codex -> CoS agents` calls are not reliable because CoS agents require proven ChatGPT conversation ownership. Keep the real broker-prime conversation in the design.

### Plugin refresh / cached schemas

ChatGPT can retain an older tool declaration. After adding, removing, or changing plugin tools, refresh the Chat On Steroids connector. A local plugin showing `Ready` does not necessarily mean the current ChatGPT conversation has refreshed its tool schema.

### Port conflicts

The default broker port is `8788`. If another process owns it, set a different `LUNA_BROKER_PORT` and update the CoS remote plugin URL to match.

### Absolute paths

Avoid machine-specific absolute paths in repository config, prompts, or plugin manifests. The current project-scoped Codex config uses relative paths and is therefore portable.

### Operating system differences

The Core filesystem/command workflow is available on Windows, macOS, and Linux. Desktop screen/input control is not required by this orchestration design, so the system should stay focused on Core + Plugins for better portability.

## Migration smoke test

After setup, run a tiny bounded task such as:

```text
Create .runtime/portability-smoke.txt containing PORTABLE-OK.
Allow changes only to .runtime/portability-smoke.txt.
Delegate implementation to a worker and review the result.
```

Expected flow:

```text
Codex delegate_task
  -> broker_next_task
  -> CoS agents spawn
  -> worker edits allowed file
  -> broker_submit_result
  -> Codex reviewer PASS
```

If the worker reports `PLUGIN_DISABLED`, `conflicted`, missing tools, or stale schemas, refresh/reconnect the relevant Chat On Steroids connector and reuse the same worker when possible instead of opening duplicate workers.

## Recommendation

For reuse across many machines, keep this repository as the portable source of truth and treat Chat On Steroids setup as a short per-machine bootstrap step. The repository now includes a read-only `npm run doctor` command that checks the Node version, required project files, build output, and broker reachability without modifying external Chat On Steroids state.
