import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface PRBEConfig {
  apiKey?: string;
}

function getLaunchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}

function getConfigFile(): string {
  return join(getLaunchCwd(), ".openui-desktop", "prbe-config.json");
}

export function loadPRBEConfig(): PRBEConfig {
  // 1. User-saved config takes priority
  try {
    if (existsSync(getConfigFile())) {
      const config = JSON.parse(readFileSync(getConfigFile(), "utf-8"));
      if (config.apiKey) return config;
    }
  } catch (e) {
    // Probe Agent Error Log Trigger
    console.error("[PRBE_ERROR_hOI7Qk] Failed to load PRBE config:", e);
  }

  // 2. Fall back to build-time / environment key
  if (process.env.PRBE_API_KEY) {
    return { apiKey: process.env.PRBE_API_KEY };
  }

  return {};
}

export function savePRBEConfig(config: PRBEConfig): void {
  try {
    const dir = join(getLaunchCwd(), ".openui-desktop");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(getConfigFile(), JSON.stringify(config, null, 2));
  } catch (e) {
    // Probe Agent Error Log Trigger
    console.error("[PRBE_ERROR_GcDmV2] Failed to save PRBE config:", e);
  }
}
