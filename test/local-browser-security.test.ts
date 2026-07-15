import { describe, expect, it } from "vitest";
import { parseEnvExtraArgs, parseExtraArgs } from "../server/runtime-config.js";

describe("local browser security hygiene", () => {
  it("parses saved browser extra args one per line", () => {
    expect(parseExtraArgs("--disable-gpu\n--no-sandbox")).toEqual([
      "--disable-gpu",
      "--no-sandbox",
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
      parseEnvExtraArgs("--disable-gpu --no-sandbox\n--disable-dev-shm-usage"),
    ).toEqual(["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"]);
  });
});
