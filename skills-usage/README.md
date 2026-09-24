# skills-usage

Paseo plugin that adds a **Skills** composer pill to every active agent. The pill shows how many
skills the agent has already used in this chat. Pressing it opens a popover, so you stay in the
agent you are working in, with a search box and two groups:

- **Used in this chat**: skills the agent has loaded during this conversation, sorted by name,
  with a use count.
- **All skills**: every skill the running session reports, sorted by name. Skills that were used
  carry a **Used** badge here as well.

Pressing a skill puts `/skill-name` into the message input.

## Interface

- The pill label is `Skills` until the agent loads a skill, then `Skills · N`.
- On wide layouts the popover anchors to the pill. On compact layouts it opens as a bottom sheet.
- Search matches the skill name and description, case-insensitively; each word must match.
- Each row shows the name, the short description reported by the provider, and the **Used** badge or
  use count when the chat has loaded that skill.
- The icon in front of each name says where the skill lives; a legend at the bottom of the popover
  lists the icons in use:
  - **User** (person icon): under the home directory, in `~/.claude/skills`, `~/.agents/skills`,
    or `~/.codex/skills`.
  - **Project** (git folder icon): in a `.claude/skills`, `.agents/skills`, or `.codex/skills`
    directory between the agent's working directory and the repository root, tracked by git.
  - **Project (local)** (locked folder icon): in one of those project directories but untracked or
    git-ignored, so only this checkout has it.
  - **Plugin** (puzzle icon): a Claude plugin skill named `plugin:skill`.
  - **Built-in** (chip icon): reported by the provider without a skill directory on disk.
- A skill that was loaded in the chat but is no longer in the provider's list still appears under
  **Used in this chat**, marked as not in the current list.

## Where the data comes from

- **Available skills** come from the provider's live command list for that session, the same
  source the composer autocomplete uses, filtered to entries the provider tags as skills. Claude
  reports its skills; Codex reports the skills under its skills directories. Providers that
  cannot answer show their error in the popover.
- **Used skills** are read from the agent timeline: `Skill` tool calls, reads of a
  `skills/<name>/SKILL.md` file, shell commands that print such a file, `/name` slash invocations,
  and `$name` mentions in your prompts. Shell commands and prompt mentions count only when the name
  is an available skill, and heredoc bodies are ignored, so scripts that quote a skill path,
  ordinary slash commands, and shell variables do not show up as used.
- **Skill locations** are resolved by the plugin's server entry on the daemon machine. It scans
  the user directories above, walks from the agent's working directory up to the repository root
  for project directories, and asks `git ls-files` which project skills are tracked. Skill names
  match on the directory name and the `name` in `SKILL.md` frontmatter. Results are cached for
  15 seconds per working directory.

Usage is refreshed when the agent's status changes and every 15 seconds while it is running.

## Inserting into the composer

In the web and desktop apps the plugin writes into the composer text area of the agent whose pill
was pressed and appends a space, so you can continue typing the arguments. On iOS and Android the
plugin cannot reach the composer, so it copies `/skill-name` to the clipboard and shows a toast.

## Limitations

- Location icons depend on the daemon seeing the same skill directories the provider reads. Skills
  loaded from other paths, or a provider running on a different machine, show as built-in.
- Skill detection depends on what the provider records in the timeline. A skill loaded through a
  path that does not end in `SKILL.md`, or by a subagent, is not detected.
- Timelines are scanned in full when the popover or pill mounts; very long chats take a moment.

## Install

```bash
paseo plugin add panrafal/paseo-plugins:skills-usage
```

From a checkout:

```bash
npm install
npm run typecheck --workspace=skills-usage
paseo plugin install /absolute/path/to/paseo-plugins/skills-usage
paseo plugin ls
```

After editing:

```bash
npm run typecheck --workspace=skills-usage
npm test --workspace=skills-usage
paseo plugin reload skills-usage
paseo plugin logs skills-usage
```
