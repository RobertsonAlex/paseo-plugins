import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { LocatedSkill } from "../shared/contracts";

const execFileAsync = promisify(execFile);

/** Skill directories every provider here reads, relative to a project directory. */
const PROJECT_SKILL_ROOTS = [".claude/skills", ".agents/skills", ".codex/skills"];
const MAX_ANCESTORS_WITHOUT_GIT = 1;
const MAX_ANCESTORS = 12;
const GIT_TIMEOUT_MS = 5_000;

interface SkillDirectory {
  name: string;
  frontmatterName: string | null;
  path: string;
}

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function userSkillRoots(home = homedir()): string[] {
  return [join(claudeRoot(), "skills"), join(home, ".agents", "skills"), join(codexHome(), "skills")];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function frontmatterName(content: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!block?.[1]) return null;
  const line = /^name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(block[1]);
  return line?.[1]?.trim() || null;
}

async function readSkillDirectories(root: string): Promise<SkillDirectory[]> {
  const skills: SkillDirectory[] = [];
  for (const entry of await listDirectory(root)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    const skillFile = join(path, "SKILL.md");
    if (!(await isFile(skillFile))) continue;
    let name: string | null = null;
    try {
      name = frontmatterName(await readFile(skillFile, "utf8"));
    } catch {
      name = null;
    }
    skills.push({ name: entry.name, frontmatterName: name, path });
  }
  return skills;
}

export async function findGitRoot(start: string): Promise<string | null> {
  let current = resolve(start);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** The agent's working directory and its ancestors up to the repository root, nearest first. */
export function projectDirectories(cwd: string, gitRoot: string | null): string[] {
  const directories: string[] = [];
  let current = resolve(cwd);
  const limit = gitRoot ? MAX_ANCESTORS : MAX_ANCESTORS_WITHOUT_GIT;
  for (let depth = 0; depth <= limit; depth += 1) {
    directories.push(current);
    if (gitRoot && current === gitRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

/**
 * Paths under `gitRoot` that git tracks, restricted to the given directories. A symlinked skill
 * directory is tracked as a single path; a real directory is tracked through its files.
 */
export async function trackedPaths(gitRoot: string, paths: readonly string[]): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set();
  const relativePaths = paths.map((path) => relative(gitRoot, path));
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", gitRoot, "ls-files", "-z", "--", ...relativePaths],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    const files = stdout.split("\0").filter((line) => line.length > 0);
    const tracked = new Set<string>();
    for (let index = 0; index < paths.length; index += 1) {
      const rel = relativePaths[index] as string;
      if (files.some((file) => file === rel || file.startsWith(`${rel}/`))) {
        tracked.add(paths[index] as string);
      }
    }
    return tracked;
  } catch {
    return null;
  }
}

function put(found: Map<string, LocatedSkill>, name: string, entry: LocatedSkill): void {
  if (name && !found.has(name)) found.set(name, entry);
}

/**
 * Resolves every skill directory visible to an agent working in `cwd`. Project directories win
 * over user directories when a name appears in both, matching provider precedence.
 */
export async function locateSkills(cwd: string): Promise<Record<string, LocatedSkill>> {
  const found = new Map<string, LocatedSkill>();

  const gitRoot = await findGitRoot(cwd);
  const projectSkills: SkillDirectory[] = [];
  for (const directory of projectDirectories(cwd, gitRoot)) {
    for (const root of PROJECT_SKILL_ROOTS) {
      projectSkills.push(...(await readSkillDirectories(join(directory, root))));
    }
  }
  const tracked = gitRoot ? await trackedPaths(gitRoot, projectSkills.map((skill) => skill.path)) : null;
  for (const skill of projectSkills) {
    const scope = tracked && !tracked.has(skill.path) ? "project-local" : "project";
    put(found, skill.name, { scope, path: skill.path });
    if (skill.frontmatterName) put(found, skill.frontmatterName, { scope, path: skill.path });
  }

  for (const root of userSkillRoots()) {
    for (const skill of await readSkillDirectories(root)) {
      put(found, skill.name, { scope: "user", path: skill.path });
      if (skill.frontmatterName) put(found, skill.frontmatterName, { scope: "user", path: skill.path });
    }
  }

  return Object.fromEntries(found);
}
