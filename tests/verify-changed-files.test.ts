import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getChangedFiles, getVerificationScope } from "../scripts/gates/verify.mjs";

describe("getChangedFiles negative & behavior tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "verify-test-"));
    // Initialize a git repo without origin/main
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function commit(files: Record<string, string>) {
    for (const [path, contents] of Object.entries(files)) {
      writeFileSync(join(tempDir, path), contents);
    }
    execFileSync("git", ["add", "."], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir });
  }

  it("uses the full tree when origin/main is absent", () => {
    commit({ "file1.txt": "hello", "file2.txt": "world" });

    const { files, reliable } = getChangedFiles({ cwd: tempDir });

    expect(reliable).toBe(true);
    expect(files).toEqual(expect.arrayContaining(["file1.txt", "file2.txt"]));
  });

  it("includes committed changes since origin/main", () => {
    commit({ "base.txt": "base" });
    execFileSync("git", ["branch", "origin/main"], { cwd: tempDir });
    writeFileSync(join(tempDir, "committed.txt"), "new commit");
    execFileSync("git", ["add", "committed.txt"], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "change"], { cwd: tempDir });

    const { files, reliable } = getChangedFiles({ cwd: tempDir });

    expect(reliable).toBe(true);
    expect(files).toContain("committed.txt");
  });

  it("includes tracked, staged, untracked, and renamed destinations", () => {
    commit({ "original.txt": "initial", "tracked.txt": "initial" });
    writeFileSync(join(tempDir, "tracked.txt"), "modified");
    writeFileSync(join(tempDir, "original.txt"), "staged");
    execFileSync("git", ["add", "original.txt"], { cwd: tempDir });
    writeFileSync(join(tempDir, "untracked.txt"), "new");
    execFileSync("git", ["mv", "original.txt", "renamed.txt"], { cwd: tempDir });

    const { files, reliable } = getChangedFiles({ cwd: tempDir });

    expect(reliable).toBe(true);
    expect(files).toEqual(expect.arrayContaining(["tracked.txt", "renamed.txt", "untracked.txt"]));
  });

  it("runs test and smoke when a required Git lookup fails", () => {
    const failingGit = () => {
      throw new Error("git unavailable");
    };

    const { changed, reliable, needTest, needSmoke } = getVerificationScope({
      cwd: tempDir,
      gitRunner: failingGit,
    });

    expect(changed).toEqual([]);
    expect(reliable).toBe(false);
    expect(needTest).toBe(true);
    expect(needSmoke).toBe(true);
  });
});
