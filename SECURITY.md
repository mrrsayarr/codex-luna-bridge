# Security

This project is an experimental local-first orchestration bridge. It can coordinate coding workers that have access to an approved workspace, so keep its trust boundaries narrow.

## Safe defaults

- The broker binds only to `127.0.0.1` and rejects non-loopback Host headers.
- Do not expose the broker port to your LAN or the public internet.
- Do not place API keys, passwords, tokens, or other secrets in tasks, reviewer findings, or logs.
- Keep `allowed_files` scopes as small as practical.
- Treat worker results as untrusted until Codex has reviewed them.

## Reporting a vulnerability

If the repository has GitHub private vulnerability reporting enabled, prefer that channel. Otherwise open an issue with a minimal reproduction and omit secrets or sensitive machine information.

Please do not publish working exploit details before maintainers have had a reasonable chance to review the report.
