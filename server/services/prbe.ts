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
  try {
    if (existsSync(getConfigFile())) {
      return JSON.parse(readFileSync(getConfigFile(), "utf-8"));
    }
  } catch (e) {
    console.error("Failed to load PRBE config:", e);
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
    console.error("Failed to save PRBE config:", e);
  }
}
