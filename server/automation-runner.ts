import { Cron } from "croner";
import { OwnerMessageService } from "./owner-messages.js";
import { sendImessage } from "./sendblue.js";
import { StateStore, type AutomationRecord } from "./state.js";

export function startAutomationLoop(
  state: StateStore,
  messages: OwnerMessageService,
  intervalMs = 30_000,
): () => void {
  const tick = () => {
    for (const automation of state.claimDueAutomations()) {
      void runAutomation(state, messages, automation).catch((error) => {
        console.error(`[automation ${automation.id}] failed`, error);
      });
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

async function runAutomation(
  state: StateStore,
  messages: OwnerMessageService,
  automation: AutomationRecord,
): Promise<void> {
  if (!automation.runId) throw new Error("Claimed automation has no run id.");
  let status: "completed" | "failed" = "completed";
  let result = "";
  let error: string | undefined;
  try {
    result = await messages.runAutomation(automation);
    if (automation.conversationId.startsWith("sms:")) {
      await sendImessage(
        automation.conversationId.slice(4),
        `[${automation.name}]\n\n${result}`,
      );
    }
  } catch (caught) {
    status = "failed";
    error = caught instanceof Error ? caught.message : String(caught);
  }
  state.finishAutomationRun({
    runId: automation.runId,
    automationId: automation.id,
    status,
    result,
    error,
    nextRunAt: nextRunFor(automation.schedule, automation.timezone),
  });
}

export function nextRunFor(schedule: string, timezone: string): number | null {
  try {
    return new Cron(schedule, { paused: true, timezone }).nextRun()?.getTime() ?? null;
  } catch {
    return null;
  }
}
