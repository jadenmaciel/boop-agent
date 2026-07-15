#!/usr/bin/env node
import "dotenv/config";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const errors = [];
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 22) errors.push(`Node 22 is required; found ${process.versions.node}.`);

for (const name of [
  "BOOP_OWNER_NUMBER",
  "BOOP_CONFIRMATION_HMAC_SECRET",
  "SENDBLUE_API_KEY",
  "SENDBLUE_API_SECRET",
  "SENDBLUE_FROM_NUMBER",
]) {
  if (!process.env[name]?.trim()) errors.push(`${name} is required.`);
}
if (!/^\+[1-9]\d{7,14}$/.test(process.env.BOOP_OWNER_NUMBER ?? "")) {
  errors.push("BOOP_OWNER_NUMBER must use E.164 format.");
}
if ((process.env.BOOP_CONFIRMATION_HMAC_SECRET ?? "").length < 32) {
  errors.push("BOOP_CONFIRMATION_HMAC_SECRET must contain at least 32 characters.");
}

const databasePath = process.env.BOOP_DATABASE_PATH ?? "/var/lib/boop/boop.db";
const vaultRoot = process.env.BOOP_VAULT_ROOT ?? "/srv/boop/personal";
for (const directory of [dirname(databasePath), vaultRoot]) {
  try {
    accessSync(directory, constants.R_OK | constants.W_OK);
  } catch {
    errors.push(`Boop needs read/write access to ${directory}.`);
  }
}

const codexHome = process.env.BOOP_CODEX_AUTH_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
if (!existsSync(join(codexHome, "auth.json"))) errors.push("Codex auth.json is missing.");
if (spawnSync("codex", ["--version"], { stdio: "ignore" }).status !== 0) {
  errors.push("The codex executable is unavailable.");
}

if (errors.length) {
  for (const error of errors) console.error(`preflight: ${error}`);
  process.exit(1);
}
console.log("preflight: ok");
