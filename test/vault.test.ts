import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BulkApprovalRequired, VaultService } from "../server/vault.js";

const roots: string[] = [];

afterEach(() => {
  delete process.env.BOOP_SYNC_BULK_MANIFEST_PATH;
  delete process.env.BOOP_READ_ONLY_DIR;
  delete process.env.BOOP_SYNC_PATH1_ID;
  delete process.env.BOOP_SYNC_PATH2_ID;
  delete process.env.BOOP_SYNC_SESSION_ID;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "boop-vault-"));
  roots.push(path);
  return path;
}

describe("Vault tools", () => {
  it("blocks traversal, protected paths, and symlinks that escape the Vault", () => {
    const vaultRoot = root();
    const outside = root();
    writeFileSync(join(outside, "secret.txt"), "secret");
    writeFileSync(join(vaultRoot, "safe"), "safe");
    symlinkSync(outside, join(vaultRoot, "escape"));
    const vault = new VaultService(vaultRoot);

    expect(() => vault.readText("../outside.txt")).toThrow(/outside the Vault/);
    expect(() => vault.readText("Secure/file.txt")).toThrow(/protected/);
    expect(() => vault.readText("escape/secret.txt")).toThrow(/symlink/);
    expect(() => vault.writeText("../outside.txt", "blocked")).toThrow(/outside the Vault/);
    expect(() => vault.writeBinary("escape/image.png", Buffer.from("blocked"))).toThrow(/symlink/);
    expect(() => vault.manifestFor("escape")).toThrow(/symlink/);
    expect(() => vault.trash("../outside.txt")).toThrow(/outside the Vault/);
    expect(() => vault.move("escape", "moved")).toThrow(/symlink/);
    expect(() => vault.move("safe", "escape/moved")).toThrow(/symlink/);
  });

  it("keeps Obsidian and hidden agent state outside every Vault operation", () => {
    const vaultRoot = root();
    const protectedNames = [
      "oBsIdIaN",
      "SeCuRe",
      ".GiT",
      ".BoOp",
      ".BOOP-TRASH",
      ".research",
      ".omx",
      ".CLAUDE",
      ".code-review-graph",
      ".token-usage",
      ".codex",
    ];
    for (const name of protectedNames) {
      mkdirSync(join(vaultRoot, name));
      writeFileSync(join(vaultRoot, name, "private.md"), "protected needle");
    }
    writeFileSync(join(vaultRoot, "public.md"), "public needle");
    const vault = new VaultService(vaultRoot);

    expect(vault.searchText("needle")).toEqual([
      expect.objectContaining({ path: "public.md" }),
    ]);
    for (const name of protectedNames) {
      expect(() => vault.readText(`${name}/private.md`)).toThrow(/protected/);
      expect(() => vault.writeText(`${name}/new.md`, "blocked")).toThrow(/protected/);
      expect(() => vault.writeBinary(`${name}/new.png`, Buffer.from("blocked"))).toThrow(/protected/);
      expect(() => vault.manifestFor(name)).toThrow(/protected/);
      expect(() => vault.trash(name)).toThrow(/protected/);
      expect(() => vault.move(name, "moved")).toThrow(/protected/);
      expect(() => vault.move("public.md", `${name}/moved.md`)).toThrow(/protected/);
    }
  });

  it("requires an exact manifest approval above 25 affected files", () => {
    const vaultRoot = root();
    const dir = join(vaultRoot, "bulk");
    mkdirSync(dir);
    for (let index = 0; index < 26; index += 1) {
      writeFileSync(join(dir, `${index}.md`), String(index));
    }
    const vault = new VaultService(vaultRoot);
    const authorizationPath = join(vaultRoot, "bulk-authorization.json");
    process.env.BOOP_SYNC_BULK_MANIFEST_PATH = authorizationPath;
    process.env.BOOP_SYNC_PATH1_ID = "drive:Documents/Personal/";
    process.env.BOOP_SYNC_PATH2_ID = "/srv/boop/personal/";
    process.env.BOOP_SYNC_SESSION_ID = "drive_Documents_Personal..srv_boop_personal";

    expect(() => vault.trash("bulk")).toThrow(BulkApprovalRequired);
    const manifest = vault.manifestFor("bulk");
    expect(manifest.fileCount).toBe(26);
    expect(vault.trash("bulk", manifest.hash)).toMatchObject({ fileCount: 26 });
    const authorization = JSON.parse(readFileSync(authorizationPath, "utf8"));
    expect(authorization).toMatchObject({
      version: 1,
      mode: "bulk",
      path1: "drive:Documents/Personal/",
      path2: "/srv/boop/personal/",
      session: "drive_Documents_Personal..srv_boop_personal",
    });
    expect(authorization.files).toHaveLength(26);
    expect(authorization.files[0]).toMatchObject({ side: "vps" });
    expect(statSync(authorizationPath).mode & 0o777).toBe(0o640);
    const authorizationHash = createHash("sha256")
      .update(readFileSync(authorizationPath))
      .digest("hex");
    expect(vault.acknowledgeBulkSync("0".repeat(64))).toBe(false);
    expect(vault.acknowledgeBulkSync(authorizationHash)).toBe(true);
    expect(vault.acknowledgeBulkSync(authorizationHash)).toBe(false);
    delete process.env.BOOP_SYNC_BULK_MANIFEST_PATH;
  });

  it("fails before a bulk mutation when durable sync authorization is unavailable", () => {
    const vaultRoot = root();
    const dir = join(vaultRoot, "bulk");
    mkdirSync(dir);
    for (let index = 0; index < 26; index += 1) {
      writeFileSync(join(dir, `${index}.md`), String(index));
    }
    const vault = new VaultService(vaultRoot);
    const manifest = vault.manifestFor("bulk");

    expect(() => vault.trash("bulk", manifest.hash)).toThrow(/manifest path is not configured/);
    expect(existsSync(dir)).toBe(true);
  });

  it("does not overwrite a pending bulk authorization with a later Vault change", () => {
    const vaultRoot = root();
    for (const name of ["first", "second"]) {
      const directory = join(vaultRoot, name);
      mkdirSync(directory);
      for (let index = 0; index < 26; index += 1) {
        writeFileSync(join(directory, `${index}.md`), `${name}-${index}`);
      }
    }
    const authorizationPath = join(vaultRoot, "bulk-authorization.json");
    process.env.BOOP_SYNC_BULK_MANIFEST_PATH = authorizationPath;
    process.env.BOOP_SYNC_PATH1_ID = "drive:Documents/Personal/";
    process.env.BOOP_SYNC_PATH2_ID = "/srv/boop/personal/";
    process.env.BOOP_SYNC_SESSION_ID = "drive_Documents_Personal..srv_boop_personal";
    const vault = new VaultService(vaultRoot);

    const first = vault.manifestFor("first");
    vault.trash("first", first.hash);
    const authorizationBefore = readFileSync(authorizationPath);
    const second = vault.manifestFor("second");

    expect(() => vault.trash("second", second.hash)).toThrow(/prior bulk Vault change/);
    expect(existsSync(join(vaultRoot, "second"))).toBe(true);
    expect(readFileSync(authorizationPath)).toEqual(authorizationBefore);
  });

  it("restores a trashed item without exposing the internal trash tree", () => {
    const vaultRoot = root();
    writeFileSync(join(vaultRoot, "note.md"), "hello");
    const vault = new VaultService(vaultRoot);

    const trashed = vault.trash("note.md");
    expect(() => vault.readText(".boop-trash")).toThrow(/protected/);
    expect(() => vault.restore(trashed.operationId, "sEcUrE/note.md")).toThrow(/protected/);
    const outside = root();
    symlinkSync(outside, join(vaultRoot, "restore-escape"));
    expect(() => vault.restore(trashed.operationId, "restore-escape/note.md")).toThrow(/symlink/);
    expect(vault.restore(trashed.operationId, "restored/note.md")).toMatchObject({ fileCount: 1 });
    expect(vault.readText("restored/note.md")).toBe("hello");
  });

  it("fails closed while any root-provisioned safety marker is active", () => {
    const vaultRoot = root();
    const guards = root();
    writeFileSync(join(guards, "sync"), "1\n");
    process.env.BOOP_READ_ONLY_DIR = guards;
    const vault = new VaultService(vaultRoot);

    expect(() => vault.writeText("blocked.md", "no")).toThrow(/read-only/);
    writeFileSync(join(guards, "sync"), "0\n");
    expect(() => vault.writeText("allowed.md", "yes")).not.toThrow();
  });
});
