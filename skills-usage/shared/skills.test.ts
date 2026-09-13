import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateSkillUses,
  buildSkillGroups,
  detectSkillUses,
  listSkills,
  resolveSkillScope,
  scanTimelineEntries,
  shellCommandHead,
  skillMention,
  type TimelineItemLike,
} from "./skills";

const AT = "2026-09-13T10:00:00.000Z";

function toolCall(name: string, detail: Record<string, unknown>): TimelineItemLike {
  return { type: "tool_call", callId: "c1", name, detail, status: "completed", error: null };
}

describe("detectSkillUses", () => {
  it("reads the Claude Skill tool call label", () => {
    const uses = detectSkillUses(
      toolCall("Skill", { type: "plain_text", label: "paseo-plugin", icon: "sparkles" }),
      AT,
    );
    assert.deepEqual(uses, [{ name: "paseo-plugin", at: AT, source: "tool" }]);
  });

  it("reads a SKILL.md path from read and shell details", () => {
    assert.deepEqual(
      detectSkillUses(toolCall("Read", { type: "read", filePath: "/home/u/.codex/skills/xlsx/SKILL.md" }), AT),
      [{ name: "xlsx", at: AT, source: "tool" }],
    );
    assert.deepEqual(
      detectSkillUses(
        toolCall("Bash", { type: "shell", command: "cat ~/.claude/skills/dataviz/SKILL.md && ls" }),
        AT,
      ),
      [{ name: "dataviz", at: AT, source: "command" }],
    );
    assert.deepEqual(
      detectSkillUses(toolCall("Read", { type: "read", filePath: "/repo/docs/SKILL.md.bak" }), AT),
      [],
    );
  });

  it("reads slash and dollar mentions from user messages as message uses", () => {
    assert.deepEqual(detectSkillUses({ type: "user_message", text: "/review-code the diff" }, AT), [
      { name: "review-code", at: AT, source: "message" },
    ]);
    assert.deepEqual(detectSkillUses({ type: "user_message", text: "use $xlsx and $HOME" }, AT), [
      { name: "xlsx", at: AT, source: "message" },
      { name: "HOME", at: AT, source: "message" },
    ]);
    assert.deepEqual(detectSkillUses({ type: "user_message", text: "plain prompt" }, AT), []);
  });

  it("dedupes names within one item and ignores other item types", () => {
    assert.equal(
      detectSkillUses(
        toolCall("Bash", { type: "shell", command: "cat skills/a/SKILL.md; cat skills/a/SKILL.md" }),
        AT,
      ).length,
      1,
    );
    assert.deepEqual(detectSkillUses({ type: "assistant_message", text: "/xlsx" }, AT), []);
  });

  it("ignores SKILL.md mentions that are not skills/<name>/SKILL.md paths or valid names", () => {
    const junk = [
      "grep -rn ']*/SKILL.md' .",
      "const R = /([^/\\\\\\s\"'`]+)[/\\\\]SKILL\\.md/",
      "cat docs/SKILL.md",
      "cat skills/../SKILL.md",
      "cat skills/[bad]/SKILL.md",
    ];
    for (const command of junk) {
      assert.deepEqual(detectSkillUses(toolCall("Bash", { type: "shell", command }), AT), [], command);
    }
    assert.deepEqual(detectSkillUses(toolCall("Skill", { type: "plain_text", label: "]*" }), AT), []);
    assert.deepEqual(
      detectSkillUses(toolCall("Bash", { type: "shell", command: "cat ~/.claude/plugins/cache/x/skills/deploy-it/SKILL.md" }), AT),
      [{ name: "deploy-it", at: AT, source: "command" }],
    );
  });

  it("ignores SKILL.md paths inside heredoc bodies", () => {
    const command = [
      "cd repo && python3 - <<'EOF'",
      "print('cat skills/a/SKILL.md')",
      "EOF",
      "cat ~/.claude/skills/xlsx/SKILL.md",
      'cat > notes.md <<"NOTES"',
      "skills/deploy-it/SKILL.md",
      "NOTES",
    ].join("\n");
    assert.equal(shellCommandHead(command).includes("skills/a/"), false);
    assert.deepEqual(detectSkillUses(toolCall("Bash", { type: "shell", command }), AT), [
      { name: "xlsx", at: AT, source: "command" },
    ]);
  });
});

describe("aggregateSkillUses", () => {
  it("counts tool uses always and command or message uses only for available skills", () => {
    const used = aggregateSkillUses(
      [
        { name: "xlsx", at: "2026-09-13T09:00:00.000Z", source: "tool" },
        { name: "xlsx", at: AT, source: "message" },
        { name: "HOME", at: AT, source: "message" },
        { name: "a", at: AT, source: "command" },
        { name: "hidden", at: AT, source: "tool" },
      ],
      new Set(["xlsx"]),
    );
    assert.deepEqual([...used.keys()], ["xlsx", "hidden"]);
    assert.deepEqual(used.get("xlsx"), { name: "xlsx", count: 2, lastUsedAt: AT });
  });
});

describe("listSkills", () => {
  it("keeps skills, drops commands, and treats untagged entries as skills", () => {
    const skills = listSkills([
      { name: "clear", description: "Clear", argumentHint: "", kind: "command" },
      { name: "xlsx", description: "Sheets", argumentHint: "", kind: "skill" },
      { name: "legacy", description: "", argumentHint: "" },
      { name: "xlsx", description: "dupe", argumentHint: "", kind: "skill" },
    ]);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["xlsx", "legacy"],
    );
  });
});

describe("buildSkillGroups", () => {
  const available = [
    { name: "zeta", description: "Last one", argumentHint: "" },
    { name: "Alpha", description: "Starts things", argumentHint: "" },
    { name: "mid", description: "Middle", argumentHint: "" },
  ];
  const uses = scanTimelineEntries([
    { item: toolCall("Skill", { type: "plain_text", label: "zeta" }), timestamp: AT },
    { item: { type: "user_message", text: "/mid now" }, timestamp: AT },
    { item: toolCall("Skill", { type: "plain_text", label: "ghost" }), timestamp: AT },
  ]);

  it("sorts both groups by name and marks used rows in the full list", () => {
    const groups = buildSkillGroups({ available, uses, query: "" });
    assert.deepEqual(
      groups.used.map((row) => row.name),
      ["ghost", "mid", "zeta"],
    );
    assert.equal(groups.used[0]?.available, false);
    assert.deepEqual(
      groups.all.map((row) => [row.name, row.used]),
      [
        ["Alpha", false],
        ["mid", true],
        ["zeta", true],
      ],
    );
  });

  it("filters both groups by name or description, case-insensitively", () => {
    const groups = buildSkillGroups({ available, uses, query: "MIDDLE" });
    assert.deepEqual(groups.used.map((row) => row.name), ["mid"]);
    assert.deepEqual(groups.all.map((row) => row.name), ["mid"]);
    assert.deepEqual(buildSkillGroups({ available, uses, query: "ghost" }).all, []);
  });
});

describe("resolveSkillScope", () => {
  const found = { xlsx: { scope: "user" as const }, deploy: { scope: "project-local" as const } };

  it("uses the located scope, then plugin prefix, then builtin", () => {
    assert.equal(resolveSkillScope("xlsx", found), "user");
    assert.equal(resolveSkillScope("deploy", found), "project-local");
    assert.equal(resolveSkillScope("acme:review", found), "plugin");
    assert.equal(resolveSkillScope("autocompact", found), "builtin");
    assert.equal(resolveSkillScope("xlsx", null), null);
  });

  it("stamps rows in both groups", () => {
    const groups = buildSkillGroups({
      available: [{ name: "xlsx", description: "", argumentHint: "" }],
      uses: [{ name: "xlsx", at: AT, source: "tool" }, { name: "ghost", at: AT, source: "tool" }],
      query: "",
      scopes: found,
    });
    assert.deepEqual(groups.all.map((row) => row.scope), ["user"]);
    assert.deepEqual(groups.used.map((row) => [row.name, row.scope]), [["ghost", "builtin"], ["xlsx", "user"]]);
  });
});

describe("skillMention", () => {
  it("formats a slash mention", () => {
    assert.equal(skillMention("xlsx"), "/xlsx");
  });
});
