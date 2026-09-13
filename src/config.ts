import path from "node:path";

export interface AppConfig {
  taskStatePath: string;
  maxReworkRounds: number;
  brokerPort: number;
  brokerPath: string;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2) {
    throw new Error(`Expected an integer from 0 through 2, received: ${value}`);
  }
  return parsed;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`Expected a TCP port from 1024 through 65535, received: ${value}`);
  }
  return parsed;
}

function parseBrokerPath(value: string | undefined): string {
  const brokerPath = value?.trim() || "/mcp";
  if (!/^\/[A-Za-z0-9/_-]*$/.test(brokerPath)) {
    throw new Error(`Invalid LUNA_BROKER_PATH: ${brokerPath}`);
  }
  return brokerPath;
}

export function loadConfig(cwd = process.cwd()): AppConfig {
  const statePath = process.env.TASK_STATE_PATH?.trim() || ".runtime/tasks.json";

  return {
    taskStatePath: path.resolve(cwd, statePath),
    maxReworkRounds: parsePositiveInteger(process.env.MAX_REWORK_ROUNDS, 2),
    brokerPort: parsePort(process.env.LUNA_BROKER_PORT, 8788),
    brokerPath: parseBrokerPath(process.env.LUNA_BROKER_PATH),
  };
}
