import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEV_SERVER_URL = "http://127.0.0.1:1420";
const HEALTH_TIMEOUT_MS = 1_500;

if (await hasHealthyDevServer()) {
  console.log(`Reusing desktop dev server at ${DEV_SERVER_URL}.`);
  process.exit(0);
}

const viteBin = findViteBin(packageRoot);
const child = spawn(process.execPath, [viteBin], {
  cwd: packageRoot,
  stdio: "inherit"
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

function findViteBin(startDir) {
  let dir = startDir;

  while (true) {
    const candidate = path.join(dir, "node_modules", "vite", "bin", "vite.js");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  throw new Error("Could not find vite binary. Run npm install from the workspace root.");
}

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
