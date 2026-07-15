import type { RuntimeTool } from "../runtimes/types.js";

export interface IntegrationModule {
  name: string;
  description: string;
  requiredEnv?: string[];
  isEnabled?: () => Promise<boolean>;
  createTools: (ctx: IntegrationContext) => Promise<RuntimeTool[]>;
}

export interface IntegrationContext {
  conversationId?: string;
}

const registry = new Map<string, IntegrationModule>();

export function registerIntegration(mod: IntegrationModule): void {
  registry.set(mod.name, mod);
}

export function listIntegrations(): IntegrationModule[] {
  return [...registry.values()];
}

export async function listEnabledIntegrations(): Promise<IntegrationModule[]> {
  const out: IntegrationModule[] = [];
  for (const mod of registry.values()) {
    try {
      if (!mod.isEnabled || (await mod.isEnabled())) out.push(mod);
    } catch (err) {
      console.warn(`[integrations] failed to check ${mod.name} enabled state`, err);
    }
  }
  return out;
}

export function getIntegration(name: string): IntegrationModule | undefined {
  return registry.get(name);
}

export async function loadIntegrations(): Promise<void> {
  const { registerComposioToolkits } = await import("./composio-loader.js");
  await registerComposioToolkits();
  const { registerBrowserIntegration } = await import("./browser-loader.js");
  registerBrowserIntegration();
  const loaded = [...registry.keys()];
  const enabled = (await listEnabledIntegrations()).map((i) => i.name);
  console.log(
    `[integrations] loaded: ${loaded.join(", ") || "(none — ask Boop to connect a toolkit)"}; enabled: ${enabled.join(", ") || "(none)"}`,
  );
}

export async function refreshIntegrations(): Promise<void> {
  registry.clear();
  await loadIntegrations();
}

export function makeContext(conversationId?: string): IntegrationContext {
  return { conversationId };
}

export async function buildRuntimeToolsForIntegrations(
  names: string[],
  conversationId?: string,
): Promise<RuntimeTool[]> {
  const ctx = makeContext(conversationId);
  const out: RuntimeTool[] = [];
  for (const name of names) {
    const mod = registry.get(name);
    if (!mod) {
      console.warn(`[integrations] unknown integration: ${name}`);
      continue;
    }
    if (mod.isEnabled && !(await mod.isEnabled())) {
      console.warn(`[integrations] skipped disabled integration: ${name}`);
      continue;
    }
    try {
      out.push(...(await mod.createTools(ctx)));
    } catch (err) {
      console.error(`[integrations] failed to build runtime tools for ${name}`, err);
    }
  }
  return out;
}
