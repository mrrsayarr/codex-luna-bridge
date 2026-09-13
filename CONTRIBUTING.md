# Contributing

Contributions that keep the project small, local-first, and easy to audit are welcome.

Before submitting a change:

1. Keep the Codex / broker-prime / worker responsibility split intact.
2. Avoid adding databases, Redis, Docker, vector stores, or orchestration frameworks unless there is a clear need.
3. Preserve loopback-only broker behavior unless a separate, explicitly secured transport is being designed.
4. Run:

   ```bash
   npm ci
   npm run check
   npm run doctor
   ```

5. Update README documentation when behavior or setup changes.

Bug reports should include the Node version, operating system, the failing step, and the exact error message. Do not include secrets.
