import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Where a skill's files live, from the agent's point of view.
 *
 * - `user`: the home directory (`~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`).
 * - `project`: a `.claude/skills`, `.agents/skills`, or `.codex/skills` directory between the
 *   agent's working directory and the repository root, and tracked by git.
 * - `project-local`: the same project directories, but the skill is untracked or git-ignored, so
 *   only this checkout has it.
 * - `plugin`: a Claude plugin skill (`plugin:skill`), not found on disk by this plugin.
 * - `builtin`: reported by the provider without any file on disk.
 */
export const SkillScopeSchema = z.enum(["user", "project", "project-local", "plugin", "builtin"]);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const LocatedSkillSchema = z.object({
  scope: SkillScopeSchema,
  path: z.string(),
});
export type LocatedSkill = z.infer<typeof LocatedSkillSchema>;

export const locateSkillsRpc = defineRpc({
  name: "skills.locate",
  input: z.object({ agentId: z.string() }),
  output: z.object({
    /** Skill name (directory name and frontmatter name) to the location that provides it. */
    found: z.record(z.string(), LocatedSkillSchema),
    error: z.string().nullable(),
  }),
});
