import { describe, expect, it } from "vitest";
import {
  assertSafeBrowserExtraArgs,
  parseEnvExtraArgs,
  parseExtraArgs,
} from "../server/runtime-config.js";

describe("local browser security hygiene", () => {
  it("parses saved browser extra args one per line", () => {
    expect(parseExtraArgs("--disable-gpu\n--disable-dev-shm-usage")).toEqual([
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ]);
  });

  it("drops high-risk browser extra args", () => {
    expect(
      parseExtraArgs(
        [
          "--disable-gpu",
          "--remote-debugging-port=9222",
          "--disable-web-security",
          "--load-extension=/tmp/example",
          "--proxy-server=http://127.0.0.1:8080",
        ].join("\n"),
      ),
    ).toEqual(["--disable-gpu"]);
  });

  it("parses environment browser extra args with shell-style spacing", () => {
    expect(
      parseEnvExtraArgs("--disable-gpu --disable-dev-shm-usage"),
    ).toEqual(["--disable-gpu", "--disable-dev-shm-usage"]);
  });

  it("rejects sandbox-disabling args from settings, env, and the final launch array", () => {
    expect(() => assertSafeBrowserExtraArgs(["--disable-gpu"])).not.toThrow();
    expect(() =>
      assertSafeBrowserExtraArgs(["--host-resolver-rules=MAP example.com 192.0.2.1"]),
    ).not.toThrow();
    for (const flag of [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu-sandbox",
      "--disable-namespace-sandbox",
      "--disable-seccomp-filter-sandbox",
      "--disable-seccomp-sandbox",
      "--disable-zygote-sandbox",
      "--no-zygote-sandbox",
      "--disable-sandbox",
      "--service-sandbox-type",
      "--utility-sandbox-type",
      "--single-process",
      "--in-process-gpu",
    ]) {
      for (const arg of [flag, `${flag.toUpperCase()}=none`]) {
        expect(() => parseExtraArgs(arg)).toThrow(/disable the browser sandbox/i);
        expect(() => parseEnvExtraArgs(arg)).toThrow(/disable the browser sandbox/i);
        expect(() => assertSafeBrowserExtraArgs([arg])).toThrow(/sandbox/i);
      }
    }
  });
});
