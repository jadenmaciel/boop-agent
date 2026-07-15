import { homedir } from "node:os";
import { join } from "node:path";
import { getStateStore } from "./state-instance.js";
import type { RuntimeReasoningEffort } from "./runtimes/types.js";

export interface RuntimeConfig {
  runtime: "codex";
  model: string;
  reasoningEffort: RuntimeReasoningEffort;
  billingMode: "codex-subscription";
}

export interface BrowserSettings {
  enabled: boolean;
  profileDir: string;
  showUi: boolean;
  loginHandoffEnabled: boolean;
  startUrl: string;
  channel: string;
  executablePath: string;
  extraArgs: string[];
}

const REASONING = new Set<RuntimeReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const BLOCKED_BROWSER_EXTRA_ARGS = new Set([
  "--allow-running-insecure-content",
  "--disable-extensions-except",
  "--disable-web-security",
  "--load-extension",
  "--remote-allow-origins",
  "--remote-debugging-address",
  "--remote-debugging-port",
  "--unsafely-treat-insecure-origin-as-secure",
  "--user-data-dir",
]);

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const state = getStateStore();
  const effort = resolveReasoningEffortInput(
    state.getSetting("codex_reasoning_effort") ??
      process.env.BOOP_CODEX_REASONING_EFFORT ??
      "medium",
  );
  return {
    runtime: "codex",
    model: state.getSetting("codex_model") ?? process.env.BOOP_CODEX_MODEL ?? "gpt-5.5",
    reasoningEffort: effort ?? "medium",
    billingMode: "codex-subscription",
  };
}

export async function setRuntimeModel(model: string): Promise<void> {
  if (!/^gpt-[a-z0-9.-]+$/i.test(model)) throw new Error("Invalid Codex model name.");
  getStateStore().setSetting("codex_model", model);
}

export async function setCodexReasoningEffort(effort: RuntimeReasoningEffort): Promise<void> {
  if (!REASONING.has(effort)) throw new Error("Invalid reasoning effort.");
  getStateStore().setSetting("codex_reasoning_effort", effort);
}

export function resolveReasoningEffortInput(input: string): RuntimeReasoningEffort | null {
  const value = input.trim().toLowerCase() as RuntimeReasoningEffort;
  return REASONING.has(value) ? value : null;
}

export function parseExtraArgs(input: string | null): string[] {
  if (!input) return [];
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("--"))
    .filter((line) => {
      const flag = line.toLowerCase().split(/[=\s]/, 1)[0]!;
      return !BLOCKED_BROWSER_EXTRA_ARGS.has(flag);
    });
}

export function parseEnvExtraArgs(input: string | undefined): string[] {
  return parseExtraArgs(input?.replace(/[ \t]+/g, "\n") ?? null);
}

export async function getBrowserSettings(): Promise<BrowserSettings> {
  const state = getStateStore();
  return {
    enabled: boolSetting(state.getSetting("browser_enabled"), process.env.BOOP_BROWSER_ENABLED, true),
    profileDir:
      state.getSetting("browser_profile_dir") ??
      process.env.BOOP_BROWSER_PROFILE_DIR ??
      join(homedir(), ".boop", "browser-profile"),
    showUi: boolSetting(state.getSetting("browser_show_ui"), process.env.BOOP_BROWSER_SHOW_UI, false),
    loginHandoffEnabled: boolSetting(
      state.getSetting("browser_login_handoff"),
      process.env.BOOP_BROWSER_LOGIN_HANDOFF,
      true,
    ),
    startUrl: state.getSetting("browser_start_url") ?? process.env.BOOP_BROWSER_START_URL ?? "",
    channel: state.getSetting("browser_channel") ?? process.env.BOOP_BROWSER_CHANNEL ?? "chrome",
    executablePath:
      state.getSetting("browser_executable_path") ??
      process.env.BOOP_BROWSER_EXECUTABLE_PATH ??
      "",
    extraArgs: parseExtraArgs(state.getSetting("browser_extra_args"))
      .concat(parseEnvExtraArgs(process.env.BOOP_BROWSER_EXTRA_ARGS)),
  };
}

function boolSetting(stored: string | null, env: string | undefined, fallback: boolean): boolean {
  const value = stored ?? env;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}
