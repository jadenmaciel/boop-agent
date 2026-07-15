import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BulkApprovalRequired, VaultService } from "../server/vault.js";

const roots: string[] = [];

afterEach(() => {
  delete process.env.BOOP_SYNC_BULK_MANIFEST_PATH;
  delete process.env.BOOP_READ_ONLY_DIR;
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
    symlinkSync(outside, join(vaultRoot, "escape"));
    const vault = new VaultService(vaultRoot);

    expect(() => vault.readText("../outside.txt")).toThrow(/outside the Vault/);
    expect(() => vault.readText("Secure/file.txt")).toThrow(/protected/);
    expect(() => vault.readText("escape/secret.txt")).toThrow(/symlink/);
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

    expect(() => vault.trash("bulk")).toThrow(BulkApprovalRequired);
    const manifest = vault.manifestFor("bulk");
    expect(manifest.fileCount).toBe(26);
    expect(vault.trash("bulk", manifest.hash)).toMatchObject({ fileCount: 26 });
    expect(JSON.parse(readFileSync(authorizationPath, "utf8")).files).toHaveLength(26);
    delete process.env.BOOP_SYNC_BULK_MANIFEST_PATH;
  });

  it("restores a trashed item without exposing the internal trash tree", () => {
    const vaultRoot = root();
    writeFileSync(join(vaultRoot, "note.md"), "hello");
    const vault = new VaultService(vaultRoot);

    const trashed = vault.trash("note.md");
    expect(() => vault.readText(".boop-trash")).toThrow(/protected/);
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
