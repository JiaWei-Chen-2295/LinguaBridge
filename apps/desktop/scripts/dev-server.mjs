import { spawn } from "node:child_process";

const DEV_SERVER_URL = "http://127.0.0.1:1420";
const HEALTH_TIMEOUT_MS = 1_500;

if (await hasHealthyDevServer()) {
  console.log(`Reusing desktop dev server at ${DEV_SERVER_URL}.`);
  process.exit(0);
}

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(command, ["run", "dev:web"], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: false
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

async function hasHealthyDevServer() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(DEV_SERVER_URL, {
      method: "GET",
      signal: controller.signal
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
