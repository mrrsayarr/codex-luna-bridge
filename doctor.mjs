import { access } from "node:fs/promises";
import http from "node:http";

const requiredFiles = [
  "src/server.ts",
  "src/broker.ts",
  ".codex/config.toml",
  ".codex/agents/reviewer.toml",
  "BROKER_PRIME.md",
];

const brokerPort = Number.parseInt(process.env.LUNA_BROKER_PORT ?? "8788", 10);

function pass(message) {
  console.log(`PASS  ${message}`);
}

function warn(message) {
  console.log(`WARN  ${message}`);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (nodeMajor >= 20) {
  pass(`Node.js ${process.versions.node}`);
} else {
  fail(`Node.js 20+ is required; current version is ${process.versions.node}`);
}

for (const file of requiredFiles) {
  try {
    await access(file);
    pass(`Found ${file}`);
  } catch {
    fail(`Missing ${file}`);
  }
}

try {
  await access("dist/server.js");
  pass("Build output exists at dist/server.js");
} catch {
  warn("dist/server.js is missing; run `npm run build` before launching Codex");
}

if (!Number.isInteger(brokerPort) || brokerPort < 1024 || brokerPort > 65535) {
  fail(`Invalid LUNA_BROKER_PORT: ${process.env.LUNA_BROKER_PORT}`);
} else {
  await new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port: brokerPort, path: "/health", timeout: 800 },
      (response) => {
        response.resume();
        if (response.statusCode === 200) {
          pass(`Broker is reachable on http://127.0.0.1:${brokerPort}`);
        } else {
          warn(`Port ${brokerPort} responded with HTTP ${response.statusCode}; verify the broker configuration`);
        }
        resolve();
      },
    );

    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => {
      warn(`Broker is not currently reachable on port ${brokerPort}; this is normal before Codex starts the bridge`);
      resolve();
    });
  });
}

if (process.exitCode !== 1) {
  console.log("\nEnvironment checks completed.");
}
