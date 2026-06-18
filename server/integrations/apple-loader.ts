import { createAppleMcp, createAppleTools } from "../apple/tools.js";
import { getAppleSettings } from "../runtime-config.js";
import { registerIntegration } from "./registry.js";

export function registerAppleIntegration(): void {
  registerIntegration({
    name: "apple",
    description:
      "Read-only Apple data from the user's Mac: iMessage history and Apple Notes via the local server, plus Apple Calendar events and Apple Reminders via the optional Apple bridge.",
    isEnabled: async () => (await getAppleSettings()).enabled,
    createServer: async () => createAppleMcp(),
    createTools: async () => createAppleTools(),
  });
  console.log("[apple] registered Apple data integration");
}
