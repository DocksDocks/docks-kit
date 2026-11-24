import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../../../src/skills/config.json" with { type: "json" };
import { skillCandidateDirs } from "../../../src/skills/frontmatter.ts";
import { checkDurableAnchors, checkReferences } from "../../../scripts/pluginContent/references.ts";
import {
  checkReportSection,
  checkSharedCopies,
  checkSkillFrontmatter,
  checkSkillLayout,
  checkTransformGuard,
  scoreSkills,
} from "../../../src/skills/kitGate.ts";
import { checkTriggerCollisions } from "../../../scripts/pluginContent/triggers.ts";

/**
 * The docks skill content checks, ported from DocksDocks/docks, on the kit
 * plugin skills. The live tree must pass each check. Each red test copies the
 * plugin folder into a temporary repository root, plants one violation, and
 * expects the check to fail with a message that names the file.
 */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const SKILLS = `${config.pluginDir}/skills`;

const fixtures: Array<string> = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temporary repository root with a copy of the kit plugin folder. */
function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kit-plugin-skills-"));
  fixtures.push(root);
  cpSync(join(REPO_ROOT, config.pluginDir), join(root, config.pluginDir), { recursive: true });
  return root;
}

function edit(root: string, relative: string, change: (text: string) => string): void {
  const file = join(root, relative);
  const before = readFileSync(file, "utf8");
  const after = change(before);
  expect(after, `the planted change did not change ${relative}`).not.toBe(before);
  writeFileSync(file, after);
}

function plant(root: string, relative: string, text: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const skillFile = (name: string): string => `${SKILLS}/${name}/SKILL.md`;
/** The failure for a canonical suffix that a block before it keeps from being a heading. */
const HIDDEN = "the Report section at the end is not a heading: a block before it hides it";

/** Expect a failure that names `file` and contains `detail`. */
function expectFailure(failures: ReadonlyArray<string>, file: string, detail: string): void {
  expect(
    failures.some((failure) => failure.includes(file) && failure.includes(detail)),
    `no failure names ${file} with "${detail}"; failures: ${JSON.stringify(failures)}`,
  ).toBe(true);
}

/** A minimal skill that passes the frontmatter rules. */
const minimalSkill = (name: string, description: string, body = "# Body\n"): string =>
  `---\nname: ${name}\ndescription: "${description}"\nuser-invocable: false\nmetadata:\n  updated: "2026-01-01"\n---\n\n${body}`;

describe("kit plugin skills: live tree", () => {
  it("passes the layout, frontmatter, report section, and shared copy checks", () => {
    expect(checkSkillLayout(REPO_ROOT)).toEqual([]);
    expect(checkSkillFrontmatter(REPO_ROOT)).toEqual([]);
    expect(checkReportSection(REPO_ROOT)).toEqual([]);
    expect(checkSharedCopies(REPO_ROOT)).toEqual([]);
  });

  it("passes the reference, anchor, transform, and trigger checks", () => {
    expect(checkReferences(REPO_ROOT)).toEqual([]);
    expect(checkDurableAnchors(REPO_ROOT)).toEqual([]);
    expect(checkTransformGuard(REPO_ROOT)).toEqual([]);
    expect(checkTriggerCollisions(REPO_ROOT)).toEqual([]);
  });

  it("gives each skill folder one score row at or above the floor", () => {
    const result = scoreSkills(REPO_ROOT);
    expect(result.failures).toEqual([]);
    const onDisk = skillCandidateDirs(join(REPO_ROOT, SKILLS)).map(({ name }) => name);
    expect(onDisk.length).toBeGreaterThan(0);
    expect(result.rows.map((row) => row.name)).toEqual(onDisk);
    for (const row of result.rows) {
      expect(row.score, row.name).toBeGreaterThanOrEqual(config.floors.skills);
    }
  });
});

describe("kit plugin skills: layout and name", () => {
  it("fails a skill whose name differs from its folder", () => {
    const root = copyFixture();
    edit(root, skillFile("accessibility"), (text) =>
      text.replace("name: accessibility", "name: accessible"),
    );
    expectFailure(checkSkillLayout(root), skillFile("accessibility"), "'accessible'");
    expectFailure(checkSkillFrontmatter(root), skillFile("accessibility"), "must match directory");
  });

  it("fails a SKILL.md below skills/<name>/", () => {
    const root = copyFixture();
    plant(root, `${SKILLS}/group/nested/SKILL.md`, minimalSkill("nested", "Use when nesting."));
    expectFailure(
      checkSkillLayout(root),
      `${SKILLS}/group/nested/SKILL.md`,
      "is not at skills/<name>/SKILL.md",
    );
  });
});

describe("kit plugin skills: frontmatter rules", () => {
  const file = skillFile("accessibility");
  const cases: ReadonlyArray<{
    readonly rule: string;
    readonly change: (text: string) => string;
    readonly detail: string;
  }> = [
    {
      rule: "a missing description",
      change: (text) => text.replace(/^description: .*\n/m, ""),
      detail: "`description` must be a non-empty string",
    },
    {
      rule: "a description without Use when",
      change: (text) => text.replace('description: "Use when', 'description: "For'),
      detail: "must start with `Use when`",
    },
    {
      rule: "a description longer than 1024 characters",
      change: (text) =>
        text.replace('description: "Use when', `description: "Use when ${"x".repeat(1024)}`),
      detail: "description exceeds maximum length",
    },
    {
      rule: "a plain description with a comment hazard",
      change: (text) => text.replace(/^description: .*$/m, "description: Use when a #tag"),
      detail: "contains `#`",
    },
    {
      rule: "a missing user-invocable",
      change: (text) => text.replace(/^user-invocable: .*\n/m, ""),
      detail: "`user-invocable` must be present and boolean",
    },
    {
      rule: "a bad metadata.updated",
      change: (text) => text.replace(/updated: "[^"]*"/, 'updated: "October"'),
      detail: "metadata.updated must be present",
    },
    {
      rule: "a bad metadata.content_hash",
      change: (text) => text.replace(/content_hash: "[^"]*"/, 'content_hash: "ABC"'),
      detail: "metadata.content_hash must be a 64-character",
    },
    {
      rule: "a name that is not hyphen-case",
      change: (text) => text.replace("name: accessibility", "name: Access_ibility"),
      detail: "must be lowercase hyphen-case",
    },
    {
      rule: "a missing frontmatter fence",
      change: (text) => text.replace(/^---\n/, ""),
      detail: "must start with YAML frontmatter fence",
    },
    {
      rule: "invalid YAML",
      change: (text) =>
        text.replace("user-invocable: false", "user-invocable: false\nuser-invocable: true"),
      detail: "invalid YAML frontmatter",
    },
    {
      rule: "a body over 500 lines",
      change: (text) => `${text}${"line\n".repeat(500)}`,
      detail: "(cap: 500)",
    },
  ];

  for (const { rule, change, detail } of cases) {
    it(`fails ${rule}`, () => {
      const root = copyFixture();
      edit(root, file, change);
      expectFailure(checkSkillFrontmatter(root), file, detail);
    });
  }

  it("fails a nested folder under references/", () => {
    const root = copyFixture();
    plant(root, `${SKILLS}/accessibility/references/deep/note.md`, "# Note\n");
    expectFailure(checkSkillFrontmatter(root), file, "must stay one level deep");
  });
});

describe("kit plugin skills: report section and shared copies", () => {
  it("fails a changed report section", () => {
    const root = copyFixture();
    edit(root, skillFile("zoom-out"), (text) =>
      text.replace("Leave out secrets", "Leave out passwords"),
    );
    expectFailure(checkReportSection(root), skillFile("zoom-out"), "missing the Report section");
  });

  it("fails a skill without the report section", () => {
    const root = copyFixture();
    edit(root, skillFile("zoom-out"), (text) =>
      text.replace("## Report a problem with this skill", "## Report"),
    );
    expectFailure(checkReportSection(root), skillFile("zoom-out"), "missing the Report section");
  });

  it("fails a stale report section before the canonical one", () => {
    const root = copyFixture();
    edit(
      root,
      skillFile("zoom-out"),
      (text) =>
        `${text.replace("Leave out secrets", "Leave out passwords")}\n${config.reportSection}`,
    );
    expectFailure(checkReportSection(root), skillFile("zoom-out"), "has 2 Report sections");
  });

  for (const { shape, stale } of [
    { shape: "an indented", stale: "   ## Report a problem with this skill" },
    { shape: "a closed", stale: "## Report a problem with this skill ##" },
    { shape: "a CRLF", stale: "## Report a problem with this skill\r" },
    { shape: "a blockquote", stale: "> ## Report a problem with this skill" },
    { shape: "a list item", stale: "- ## Report a problem with this skill" },
    {
      shape: "an inline-comment",
      stale: "## Report a problem with this skill <!-- draft -->",
    },
    {
      shape: "an HTML-span",
      stale: '## <span title="a > b">Report a problem with this skill</span>',
    },
    {
      shape: "an empty-comment",
      stale: "## <!-->Report a problem with this skill<!-- draft -->",
    },
    { shape: "a character-reference", stale: "## Report&#32;a problem with this skill" },
    { shape: "a line-break", stale: "## Report a problem<br>with this skill" },
    { shape: "an inline-split", stale: "## <span>Re</span>port a problem with this skill" },
  ]) {
    it(`fails ${shape} stale report heading before the canonical one`, () => {
      const root = copyFixture();
      edit(
        root,
        skillFile("zoom-out"),
        (text) =>
          `${text.replace("## Report a problem with this skill", stale)}\n${config.reportSection}`,
      );
      expectFailure(checkReportSection(root), skillFile("zoom-out"), "has 2 Report sections");
    });
  }

  it("fails a stale report section that a `<!--` in a YAML literal would hide", () => {
    const root = copyFixture();
    edit(
      root,
      skillFile("zoom-out"),
      (text) =>
        `${text
          .replace("---\n", "---\nnote: |\n  <!-- draft\n")
          .replace("Leave out secrets", "Leave out passwords")}\n-->\n\n${config.reportSection}`,
    );
    expectFailure(checkReportSection(root), skillFile("zoom-out"), "has 2 Report sections");
  });

  it("fails a canonical report section inside a block quote", () => {
    const root = copyFixture();
    edit(root, skillFile("zoom-out"), (text) =>
      text.replace("## Report a problem with this skill", "> ## Report a problem with this skill"),
    );
    expectFailure(checkReportSection(root), skillFile("zoom-out"), "missing the Report section");
  });

  for (const { place, before, after, detail } of [
    { place: "inside an unclosed code fence", before: "```text\n", after: "", detail: HIDDEN },
    {
      place: "inside an unclosed HTML comment",
      before: "<!-- draft\n\n",
      after: "",
      detail: HIDDEN,
    },
    {
      place: "after an unclosed fence in a list item",
      before: "- item\n\n  ```text\n\n",
      after: "```text\nx\n```\n\n",
      detail: "has 2 Report sections",
    },
  ]) {
    it(`fails a stale report section ${place} before the canonical one`, () => {
      const root = copyFixture();
      edit(
        root,
        skillFile("zoom-out"),
        (text) =>
          `${text.replace("## Report a problem with this skill", `${before}## Report a problem with this skill`)}${after}${config.reportSection}`,
      );
      expectFailure(checkReportSection(root), skillFile("zoom-out"), detail);
    });
  }

  it("passes a report heading quoted inside a closed fence", () => {
    const root = copyFixture();
    edit(root, skillFile("zoom-out"), (text) =>
      text.replace(
        "## Report a problem with this skill",
        "```markdown\n## Report a problem with this skill\n```\n\n## Report a problem with this skill",
      ),
    );
    expect(checkReportSection(root)).toEqual([]);
  });

  for (const { shape, block, opener } of [
    { shape: "a lone opener", block: "code fence", opener: "```text\n\n" },
    { shape: "a lone opener", block: "HTML comment", opener: "<!-- draft\n\n" },
    {
      shape: "four backticks then three",
      block: "code fence",
      opener: "````text\n```\n\n",
    },
    {
      shape: "a `-->` in an earlier fenced example, then a lone `<!--`",
      block: "HTML comment",
      opener: "```html\n-->\n```\n\n<!-- draft\n\n",
    },
    {
      shape: "an inline code line that starts with three backticks, then a lone `<!--`",
      block: "HTML comment",
      opener: "```js `x` ```\n<!-- draft\n```\n\n",
    },
  ]) {
    it(`fails an unclosed ${block} (${shape}) just before the only report section`, () => {
      const root = copyFixture();
      edit(root, skillFile("zoom-out"), (text) =>
        text.replace(
          "## Report a problem with this skill",
          `${opener}## Report a problem with this skill`,
        ),
      );
      expectFailure(checkReportSection(root), skillFile("zoom-out"), HIDDEN);
    });
  }

  it("fails a list item fence that an unindented fence line follows, before the only report section", () => {
    const root = copyFixture();
    edit(root, skillFile("zoom-out"), (text) =>
      text.replace(
        "## Report a problem with this skill",
        "- item\n\n  ```text\n  code\n```\n\n## Report a problem with this skill",
      ),
    );
    expectFailure(checkReportSection(root), skillFile("zoom-out"), HIDDEN);
  });

  it("fails a list item comment that the list end leaves open, before a fence and the only report section", () => {
    const root = copyFixture();
    edit(root, skillFile("zoom-out"), (text) =>
      text.replace(
        "## Report a problem with this skill",
        "- item\n\n  <!-- draft\n\nText.\n\n```html\n<!-- example -->\n\n## Report a problem with this skill",
      ),
    );
    expectFailure(checkReportSection(root), skillFile("zoom-out"), HIDDEN);
  });

  it("fails a stale report section indented under a numbered list item before the canonical one", () => {
    const root = copyFixture();
    edit(
      root,
      skillFile("zoom-out"),
      (text) =>
        `${text
          .replace("Leave out secrets", "Leave out passwords")
          .replace(
            "## Report a problem with this skill",
            "10. Draft instructions\n\n    ## Report a problem with this skill",
          )}${config.reportSection}`,
    );
    expectFailure(checkReportSection(root), skillFile("zoom-out"), "has 2 Report sections");
  });

  for (const { shape, opener } of [
    {
      shape: "a tab-indented list comment, then an unclosed fence that holds a comment",
      opener: "10. Draft instructions\n\n\t<!-- draft\n\n```html\n<!-- example -->\n\n",
    },
    { shape: "an unclosed <pre> block", opener: "<pre>\n\n" },
  ]) {
    it(`fails the only report section hidden by ${shape}`, () => {
      const root = copyFixture();
      edit(root, skillFile("zoom-out"), (text) =>
        text.replace(
          "## Report a problem with this skill",
          `${opener}## Report a problem with this skill`,
        ),
      );
      expectFailure(checkReportSection(root), skillFile("zoom-out"), HIDDEN);
    });
  }

  it("passes a `<!--` in inline code before the only report section", () => {
    const root = copyFixture();
    edit(root, skillFile("zoom-out"), (text) =>
      text.replace(
        "## Report a problem with this skill",
        "Write `<!--` to open a comment.\n\n## Report a problem with this skill",
      ),
    );
    expect(checkReportSection(root)).toEqual([]);
  });

  // Under Node, the Markdown count runs in a Bun child; without bun on PATH the check fails, never passes.
  it.skipIf(process.versions["bun"] !== undefined)(
    "fails closed when the Bun Markdown child cannot run",
    () => {
      vi.stubEnv("PATH", "");
      try {
        expect(checkReportSection(REPO_ROOT)).toContainEqual(
          expect.stringContaining("cannot count the Report headings with Bun's Markdown parser"),
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("checks a skill whose SKILL.md is a symbolic link", () => {
    const root = copyFixture();
    const outside = join(root, "linked-SKILL.md");
    writeFileSync(outside, minimalSkill("linked", "Use when testing a linked skill."));
    mkdirSync(join(root, SKILLS, "linked"));
    symlinkSync(outside, join(root, skillFile("linked")));
    expect(scoreSkills(root).rows.map((row) => row.name)).toContain("linked");
    expectFailure(checkReportSection(root), skillFile("linked"), "missing the Report section");
  });

  it("fails an edit to one shared copy", () => {
    const root = copyFixture();
    const group = config.sharedFiles[0]!;
    const copy = group.copies[0]!;
    edit(root, copy, (text) => `${text}\nAn extra line.\n`);
    expectFailure(checkSharedCopies(root), copy, `differs from ${group.canonical}`);
  });
});

describe("kit plugin skills: references", () => {
  it("fails a broken local link", () => {
    const root = copyFixture();
    edit(root, skillFile("accessibility"), (text) => `${text}\nSee [x](references/missing.md).\n`);
    expectFailure(
      checkReferences(root),
      skillFile("accessibility"),
      "broken local link -> references/missing.md",
    );
  });

  it("fails an orphan reference", () => {
    const root = copyFixture();
    plant(root, `${SKILLS}/accessibility/references/orphan-note.md`, "# Orphan\n");
    expectFailure(
      checkReferences(root),
      skillFile("accessibility"),
      "orphan reference references/orphan-note.md",
    );
  });

  it("fails a long reference without a Contents section", () => {
    const root = copyFixture();
    const headings = "## One\n\n## Two\n\n## Three\n\n";
    plant(
      root,
      `${SKILLS}/accessibility/references/long-note.md`,
      `# Long\n\n${headings}${"line\n".repeat(100)}`,
    );
    edit(root, skillFile("accessibility"), (text) => `${text}\nSee references/long-note.md.\n`);
    expectFailure(
      checkReferences(root),
      `${SKILLS}/accessibility/references/long-note.md`,
      'no "## Contents" TOC',
    );
  });

  it("fails an anchor to an existing repository file and passes a fictional one", () => {
    const root = copyFixture();
    plant(root, "AGENTS.md", "# Agents\n");
    edit(root, skillFile("accessibility"), (text) => `${text}\nSee missing/file.ts:3.\n`);
    expect(checkDurableAnchors(root)).toEqual([]);
    edit(root, skillFile("accessibility"), (text) => `${text}\nSee AGENTS.md:42.\n`);
    expectFailure(checkDurableAnchors(root), skillFile("accessibility"), "`AGENTS.md:42`");
  });

  it("fails an anchor in an AGENTS.md node and skips the folders the guard skips", () => {
    const root = copyFixture();
    plant(root, "cli/src/main.ts", "export {};\n");
    for (const skipped of ["node_modules/pkg", ".git", "cli/dist", "cli/dist-test"]) {
      plant(root, `${skipped}/AGENTS.md`, "See cli/src/main.ts:42.\n");
    }
    expect(checkDurableAnchors(root)).toEqual([]);
    plant(root, "cli/AGENTS.md", "# CLI\n\nSee cli/src/main.ts:42.\n");
    expect(checkDurableAnchors(root)).toEqual([
      "cli/AGENTS.md:3: live line anchor `cli/src/main.ts:42`",
    ]);
  });
});

describe("kit plugin skills: transform guard", () => {
  const preservation =
    /content loss|no content|preserv|verbatim|net.?shrink|byte.?delta|section presence|drop a section|relocate.{0,12}verbatim/gi;

  it("fails a curated skill without the preservation words", () => {
    const root = copyFixture();
    edit(root, skillFile("refactor"), (text) => text.replace(preservation, "kept"));
    expectFailure(checkTransformGuard(root), skillFile("refactor"), "preservation <constraint>");
  });

  it("fails a curated skill without a verify heading", () => {
    const root = copyFixture();
    edit(root, skillFile("refactor"), (text) =>
      text.replace(/^(#{2,3}[^\n]*)\bverif(y|ication)\b/gim, "$1Checks"),
    );
    expectFailure(checkTransformGuard(root), skillFile("refactor"), "## Verification block");
  });

  it("fails a curated skill that is missing", () => {
    const root = copyFixture();
    rmSync(join(root, SKILLS, "refactor"), { recursive: true });
    expectFailure(checkTransformGuard(root), "refactor", "has no SKILL.md");
  });
});

describe("kit plugin skills: trigger collisions", () => {
  const surface = "Use when frobnicating quantum widgets, gizmos, sprockets, and turbines.";

  it("fails two unrouted skills with the same five-token trigger", () => {
    const root = copyFixture();
    plant(root, skillFile("alpha-one"), minimalSkill("alpha-one", surface));
    plant(root, skillFile("beta-two"), minimalSkill("beta-two", surface));
    const failures = checkTriggerCollisions(root);
    expectFailure(failures, skillFile("alpha-one"), skillFile("beta-two"));
  });

  it("passes the same pair when one routes to the other", () => {
    const root = copyFixture();
    plant(root, skillFile("alpha-one"), minimalSkill("alpha-one", surface));
    plant(
      root,
      skillFile("beta-two"),
      minimalSkill("beta-two", `${surface} Not for gears (use alpha-one).`),
    );
    expect(checkTriggerCollisions(root)).toEqual([]);
  });
});

describe("kit plugin skills: score floor", () => {
  it("fails a skill below the per-file floor", () => {
    const root = copyFixture();
    plant(root, skillFile("weak"), "---\nname: weak\ndescription: weak\n---\n\nWeak.\n");
    expectFailure(
      scoreSkills(root).failures,
      "weak",
      `below per-file floor ${config.floors.skills}`,
    );
  });

  it("fails a skill folder that the scorer skips", () => {
    const root = copyFixture();
    mkdirSync(join(root, SKILLS, "no-skill-file"));
    expectFailure(scoreSkills(root).failures, "no-skill-file", "unscored on disk");
  });
});
