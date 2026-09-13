import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findGitRoot, frontmatterName, locateSkills, projectDirectories } from "./locate-skills";

function skill(root: string, name: string, frontmatter = ""): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `${frontmatter}# ${name}\n`);
  return dir;
}

describe("frontmatterName", () => {
  it("reads the name field from YAML frontmatter only", () => {
    assert.equal(frontmatterName('---\nname: "Deploy It"\ndescription: x\n---\nbody'), "Deploy It");
    assert.equal(frontmatterName("---\ndescription: x\n---\nname: nope"), null);
    assert.equal(frontmatterName("no frontmatter"), null);
  });
});

describe("locateSkills", () => {
  let home = "";
  let repo = "";
  let previousHome: string | undefined;
  let previousClaude: string | undefined;
  let previousCodex: string | undefined;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "skills-home-"));
    repo = join(home, "work", "repo");
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);

    skill(join(home, ".agents", "skills"), "shared-user");
    skill(join(home, ".claude", "skills"), "claude-user", "---\nname: claude-user-alias\n---\n");
    symlinkSync(join(home, ".agents", "skills", "shared-user"), join(home, ".claude", "skills", "linked"));
    skill(join(repo, ".claude", "skills"), "committed");
    skill(join(repo, ".agents", "skills"), "untracked");
    skill(join(repo, ".codex", "skills"), "ignored");
    skill(join(repo, "packages", "app", ".claude", "skills"), "nested");
    skill(join(repo, ".claude", "skills"), "shared-user"); // shadows the user copy
    writeFileSync(join(repo, ".gitignore"), ".codex/\n");
    execFileSync("git", ["-C", repo, "add", ".gitignore", ".claude", "packages"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "skills"]);

    previousHome = process.env.HOME;
    previousClaude = process.env.CLAUDE_CONFIG_DIR;
    previousCodex = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    process.env.CODEX_HOME = join(home, ".codex");
  });

  after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    rmSync(home, { recursive: true, force: true });
  });

  it("walks from the working directory to the git root", async () => {
    const cwd = join(repo, "packages", "app");
    assert.equal(await findGitRoot(cwd), repo);
    assert.deepEqual(projectDirectories(cwd, repo), [cwd, join(repo, "packages"), repo]);
    assert.deepEqual(projectDirectories(cwd, null), [cwd, join(repo, "packages")]);
  });

  it("classifies user, project, project-local, and shadowed skills", async () => {
    const found = await locateSkills(join(repo, "packages", "app"));
    assert.equal(found["committed"]?.scope, "project");
    assert.equal(found["nested"]?.scope, "project");
    assert.equal(found["untracked"]?.scope, "project-local");
    assert.equal(found["ignored"]?.scope, "project-local");
    assert.equal(found["claude-user"]?.scope, "user");
    assert.equal(found["claude-user-alias"]?.scope, "user");
    assert.equal(found["linked"]?.scope, "user");
    assert.equal(found["shared-user"]?.scope, "project");
    assert.equal(found["shared-user"]?.path, join(repo, ".claude", "skills", "shared-user"));
    assert.equal(found["missing"], undefined);
  });

  it("treats everything under a non-git directory as project skills", async () => {
    const plain = join(home, "plain");
    skill(join(plain, ".claude", "skills"), "loose");
    const found = await locateSkills(plain);
    assert.equal(found["loose"]?.scope, "project");
  });
});
