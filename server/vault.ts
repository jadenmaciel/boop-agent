import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StateStore } from "./state.js";

const MAX_AUTONOMOUS_FILES = 25;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".csv", ".json", ".md", ".txt", ".yaml", ".yml"]);
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const PROTECTED_TOP_LEVEL = new Set([
  ".boop",
  ".boop-trash",
  ".claude",
  ".code-review-graph",
  ".codex",
  ".git",
  ".omx",
  ".research",
  ".token-usage",
  "obsidian",
  "secure",
]);

export interface VaultManifest {
  operation: "trash" | "move" | "restore";
  source: string;
  destination?: string;
  files: Array<{ path: string; size: number; mtimeMs: number }>;
  fileCount: number;
  hash: string;
}

export class BulkApprovalRequired extends Error {
  constructor(readonly manifest: VaultManifest) {
    super(`This Vault change affects ${manifest.fileCount} files and requires confirmation.`);
    this.name = "BulkApprovalRequired";
  }
}

export class VaultService {
  readonly root: string;

  constructor(
    root = process.env.BOOP_VAULT_ROOT ?? "/srv/boop/personal",
    private readonly state?: StateStore,
  ) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  readText(path: string): string {
    const absolute = this.resolveUserPath(path, true);
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error("Vault path is not a regular file.");
    if (stat.size > MAX_TEXT_BYTES) throw new Error("Vault text file exceeds 2 MB.");
    return readFileSync(absolute, "utf8");
  }

  writeText(path: string, content: string): void {
    this.writeAtomic(path, Buffer.from(content, "utf8"));
    this.journal(randomUUID(), "write", { path, bytes: Buffer.byteLength(content) });
  }

  writeBinary(path: string, content: Buffer): void {
    const dot = path.lastIndexOf(".");
    if (dot < 0 || !IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())) {
      throw new Error("Saved images require a supported image extension.");
    }
    this.writeAtomic(path, content);
    this.journal(randomUUID(), "write-binary", { path, bytes: content.byteLength });
  }

  private writeAtomic(path: string, content: string | Buffer): void {
    this.assertWritable();
    const absolute = this.resolveUserPath(path, false);
    mkdirSync(dirname(absolute), { recursive: true });
    this.assertNoSymlinkPath(dirname(absolute));
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
      throw new Error("Vault symlinks are not allowed.");
    }
    const temporary = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.tmp`);
    writeFileSync(temporary, content, { mode: 0o600 });
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, absolute);
    const directory = openSync(dirname(absolute), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  searchText(query: string, limit = 20): Array<{ path: string; excerpt: string }> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const results: Array<{ path: string; excerpt: string }> = [];
    for (const file of this.walk(this.root)) {
      if (results.length >= limit || !isTextFile(file.absolute)) continue;
      const stat = statSync(file.absolute);
      if (stat.size > MAX_TEXT_BYTES) continue;
      const text = readFileSync(file.absolute, "utf8");
      const index = text.toLowerCase().indexOf(needle);
      if (index === -1) continue;
      results.push({
        path: file.path,
        excerpt: text.slice(Math.max(0, index - 80), index + needle.length + 120),
      });
    }
    return results;
  }

  manifestFor(path: string): VaultManifest {
    return this.buildManifest("trash", path);
  }

  trash(path: string, approvedManifestHash?: string) {
    this.assertWritable();
    const manifest = this.buildManifest("trash", path);
    this.requireBulkApproval(manifest, approvedManifestHash);
    const operationId = randomUUID();
    const date = new Date().toISOString().slice(0, 10);
    const trashRoot = join(this.root, ".boop-trash", date, operationId);
    mkdirSync(trashRoot, { recursive: true });
    const source = this.resolveUserPath(path, true);
    const destination = join(trashRoot, basename(source));
    const authorization = this.authorizeBulkSync(manifest);
    try {
      renameSync(source, destination);
    } catch (error) {
      this.removeBulkSyncAuthorization(authorization);
      throw error;
    }
    this.journal(operationId, "trash", manifest);
    return { operationId, fileCount: manifest.fileCount, destination: relative(this.root, destination) };
  }

  move(sourcePath: string, destinationPath: string, approvedManifestHash?: string): void {
    this.assertWritable();
    const manifest = this.buildManifest("move", sourcePath, destinationPath);
    this.requireBulkApproval(manifest, approvedManifestHash);
    const source = this.resolveUserPath(sourcePath, true);
    const destination = this.resolveUserPath(destinationPath, false);
    mkdirSync(dirname(destination), { recursive: true });
    this.assertNoSymlinkPath(dirname(destination));
    if (existsSync(destination)) throw new Error("Vault destination already exists.");
    const authorization = this.authorizeBulkSync(manifest);
    try {
      renameSync(source, destination);
    } catch (error) {
      this.removeBulkSyncAuthorization(authorization);
      throw error;
    }
    this.journal(randomUUID(), "move", manifest);
  }

  restore(operationId: string, destinationPath: string, approvedManifestHash?: string) {
    this.assertWritable();
    if (!/^[a-f0-9-]{32,40}$/i.test(operationId)) throw new Error("Invalid trash operation ID.");
    const trashBase = join(this.root, ".boop-trash");
    const operationRoots = existsSync(trashBase)
      ? readdirSync(trashBase, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(trashBase, entry.name, operationId))
          .filter(existsSync)
      : [];
    if (operationRoots.length !== 1) throw new Error("Trash operation was not found.");
    const entries = readdirSync(operationRoots[0]!, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]!.isSymbolicLink()) {
      throw new Error("Trash operation is not restorable.");
    }
    const source = join(operationRoots[0]!, entries[0]!.name);
    const destination = this.resolveUserPath(destinationPath, false);
    const files = statSync(source).isFile()
      ? [this.fileEntry(source)]
      : this.walk(source).map((file) => this.fileEntry(file.absolute));
    files.sort((a, b) => a.path.localeCompare(b.path));
    const material = JSON.stringify({
      operation: "restore",
      source: relative(this.root, source),
      destination: destinationPath,
      files,
    });
    const manifest: VaultManifest = {
      operation: "restore",
      source: relative(this.root, source),
      destination: destinationPath,
      files,
      fileCount: files.length,
      hash: createHash("sha256").update(material).digest("hex"),
    };
    this.requireBulkApproval(manifest, approvedManifestHash);
    mkdirSync(dirname(destination), { recursive: true });
    this.assertNoSymlinkPath(dirname(destination));
    if (existsSync(destination)) throw new Error("Vault destination already exists.");
    const authorization = this.authorizeBulkSync(manifest);
    try {
      renameSync(source, destination);
    } catch (error) {
      this.removeBulkSyncAuthorization(authorization);
      throw error;
    }
    this.journal(randomUUID(), "restore", manifest);
    return { fileCount: manifest.fileCount, destination: destinationPath };
  }

  private requireBulkApproval(manifest: VaultManifest, approvedHash?: string): void {
    if (manifest.fileCount <= MAX_AUTONOMOUS_FILES) return;
    if (approvedHash !== manifest.hash) throw new BulkApprovalRequired(manifest);
  }

  private buildManifest(
    operation: "trash" | "move",
    sourcePath: string,
    destinationPath?: string,
  ): VaultManifest {
    const source = this.resolveUserPath(sourcePath, true);
    if (destinationPath) this.resolveUserPath(destinationPath, false);
    const files = statSync(source).isFile()
      ? [this.fileEntry(source)]
      : this.walk(source).map((file) => this.fileEntry(file.absolute));
    files.sort((a, b) => a.path.localeCompare(b.path));
    const material = JSON.stringify({ operation, source: sourcePath, destinationPath, files });
    return {
      operation,
      source: sourcePath,
      ...(destinationPath ? { destination: destinationPath } : {}),
      files,
      fileCount: files.length,
      hash: createHash("sha256").update(material).digest("hex"),
    };
  }

  private journal(id: string, operation: string, manifest: unknown): void {
    this.state?.recordVaultOperation({
      id,
      operation,
      manifest: JSON.stringify(manifest),
      status: "succeeded",
    });
  }

  private authorizeBulkSync(manifest: VaultManifest): string | null {
    if (manifest.fileCount <= MAX_AUTONOMOUS_FILES) return null;
    const path = process.env.BOOP_SYNC_BULK_MANIFEST_PATH;
    if (!path) throw new Error("Bulk sync manifest path is not configured.");
    const path1 = process.env.BOOP_SYNC_PATH1_ID;
    const path2 = process.env.BOOP_SYNC_PATH2_ID;
    const session = process.env.BOOP_SYNC_SESSION_ID;
    if (!path1 || !path2 || !session) {
      throw new Error("Bulk sync identity is not configured.");
    }
    if (existsSync(path)) {
      throw new Error("A prior bulk Vault change is still awaiting synchronization.");
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const payload = JSON.stringify({
        version: 1,
        mode: "bulk",
        path1,
        path2,
        session,
        expiresAt: Date.now() + 60 * 60 * 1_000,
        files: manifest.files.map((file) => ({ side: "vps", path: file.path })),
      });
      writeFileSync(temporary, payload, { mode: 0o640, flag: "wx" });
      chmodSync(temporary, 0o640);
      const file = openSync(temporary, "r");
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      linkSync(temporary, path);
      unlinkSync(temporary);
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return createHash("sha256").update(payload).digest("hex");
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }

  acknowledgeBulkSync(expectedSha256: string): boolean {
    const path = process.env.BOOP_SYNC_BULK_MANIFEST_PATH;
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || !path || !existsSync(path)) return false;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const actualSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actualSha256 !== expectedSha256) return false;
    unlinkSync(path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return true;
  }

  private removeBulkSyncAuthorization(expectedSha256: string | null): void {
    if (expectedSha256) this.acknowledgeBulkSync(expectedSha256);
  }

  private fileEntry(absolute: string) {
    const stat = statSync(absolute);
    return { path: relative(this.root, absolute), size: stat.size, mtimeMs: stat.mtimeMs };
  }

  private walk(start: string): Array<{ absolute: string; path: string }> {
    const out: Array<{ absolute: string; path: string }> = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (PROTECTED_TOP_LEVEL.has(entry.name.toLowerCase()) && directory === this.root) continue;
        const absolute = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Vault symlinks are not allowed.");
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) out.push({ absolute, path: relative(this.root, absolute) });
      }
    };
    if (statSync(start).isDirectory()) visit(start);
    else out.push({ absolute: start, path: relative(this.root, start) });
    return out;
  }

  private resolveUserPath(input: string, mustExist: boolean): string {
    if (!input || input.includes("\0") || isAbsolute(input)) {
      throw new Error("Path is outside the Vault.");
    }
    const parts = input.split(/[\\/]+/).filter((part) => part && part !== ".");
    if (parts.length === 0 || parts.includes("..")) throw new Error("Path is outside the Vault.");
    if (PROTECTED_TOP_LEVEL.has(parts[0]!.toLowerCase())) {
      throw new Error("Vault path is protected.");
    }
    const absolute = resolve(this.root, ...parts);
    this.assertContained(absolute);
    this.assertNoSymlinkPath(absolute, mustExist);
    if (mustExist && !existsSync(absolute)) throw new Error("Vault path does not exist.");
    return absolute;
  }

  private assertNoSymlinkPath(path: string, mustExist = true): void {
    const relativePath = relative(this.root, path);
    let current = this.root;
    for (const part of relativePath.split(sep).filter(Boolean)) {
      current = join(current, part);
      if (!existsSync(current)) {
        if (mustExist) throw new Error("Vault path does not exist.");
        break;
      }
      if (lstatSync(current).isSymbolicLink()) throw new Error("Vault symlinks are not allowed.");
    }
  }

  private assertContained(path: string): void {
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error("Path is outside the Vault.");
    }
  }

  private assertWritable(): void {
    const guardDirectory = process.env.BOOP_READ_ONLY_DIR;
    if (!guardDirectory) return;
    if (!existsSync(guardDirectory)) throw new Error("Vault safety directory is unavailable.");
    const locked = readdirSync(guardDirectory).some((name) =>
      readFileSync(join(guardDirectory, name), "utf8").trim() === "1");
    if (locked) throw new Error("Vault is read-only until health checks recover.");
  }
}

function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}
