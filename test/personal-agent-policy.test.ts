import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isReadOnlyTool, riskTierFor } from "../server/personal-agent.js";
import { defineRuntimeTool } from "../server/runtimes/tool.js";
import type { RuntimeTool } from "../server/runtimes/types.js";

function tool(name: string): RuntimeTool {
  return defineRuntimeTool("gmail", name, "test", { query: z.string().optional() }, async () => ({
    success: true,
    text: "ok",
  }));
}

describe("personal agent action policy", () => {
  it("allows explicit retrieval actions even when the toolkit prefixes the name", () => {
    expect(isReadOnlyTool(tool("GMAIL_FETCH_EMAILS"))).toBe(true);
    expect(isReadOnlyTool(tool("GOOGLECALENDAR_LIST_EVENTS"))).toBe(true);
  });

  it("fails closed when a tool name includes a write verb", () => {
    expect(isReadOnlyTool(tool("GMAIL_SEND_EMAIL"))).toBe(false);
    expect(isReadOnlyTool(tool("GMAIL_GET_AND_DELETE_MESSAGE"))).toBe(false);
    expect(isReadOnlyTool(tool("GMAIL_MARK_AS_READ"))).toBe(false);
    expect(isReadOnlyTool(tool("GOOGLECALENDAR_RSVP_EVENT"))).toBe(false);
  });

  it("requires Tailscale approval for nested purchases above $250", () => {
    expect(riskTierFor("checkout", { order: { total: 251 } })).toBe("high");
    expect(riskTierFor("buy", { checkout: { amount: "$1,200.00" } })).toBe("high");
    expect(riskTierFor("checkout", { order: { total: 250 } })).toBe("standard");
  });
});
