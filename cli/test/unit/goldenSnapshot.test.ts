import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  seededTreeProblems,
  snapshotTree,
  snapshotTreeResult,
  writeSeededTree,
  type SeededTree,
} from "../lib/goldenSnapshot";

function withSnapshotRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "golden-snapshot-test-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SEED: SeededTree = {
  root: ".pi/agent/intercom",
  files: { "config.json": '{\r\n  "user": true\r\n}\r\n', "notes/marker": "kept\n" },
};

describe("snapshotTreeResult", () => {
  it("gives the whole snapshot of a readable tree", () => {
    withSnapshotRoot((root) => {
      mkdirSync(join(root, "plugin"));
      writeFileSync(join(root, "plugin", "talk.js"), "bundle\n");

      expect(snapshotTreeResult(root)).toEqual({ kind: "snapshot", tree: snapshotTree(root) });
    });
  });

  // A permission does not stop root, and Windows ignores the POSIX mode.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "gives a problem and no partial snapshot when a file cannot be read",
    () => {
      withSnapshotRoot((root) => {
        writeFileSync(join(root, "a-readable"), "kept\n");
        writeFileSync(join(root, "b-unreadable"), "secret\n");
        chmodSync(join(root, "b-unreadable"), 0o000);

        // The whole result: a failure holds no tree, so no partial snapshot leaks out.
        expect(snapshotTreeResult(root)).toEqual({
          kind: "failed",
          problem: expect.stringMatching(/^ {2}the snapshot of HOME cannot be read: .*EACCES/),
        });
      });
    },
  );
});

describe("seededTreeProblems", () => {
  it("finds no problem when the seeded folder keeps its bytes and entries", () => {
    withSnapshotRoot((root) => {
      writeSeededTree(root, SEED);

      expect(seededTreeProblems(root, SEED)).toEqual([]);
    });
  });

  it("compares raw bytes, so a CRLF to LF rewrite is a problem", () => {
    withSnapshotRoot((root) => {
      writeSeededTree(root, SEED);
      writeFileSync(
        join(root, ".pi", "agent", "intercom", "config.json"),
        '{\n  "user": true\n}\n',
      );

      expect(seededTreeProblems(root, SEED)).toEqual([
        "  seeded file .pi/agent/intercom/config.json changed its bytes",
      ]);
    });
  });

  it("reports a new entry, such as a sync lock file, and a missing entry", () => {
    withSnapshotRoot((root) => {
      writeSeededTree(root, SEED);
      const folder = join(root, ".pi", "agent", "intercom");
      writeFileSync(join(folder, ".docks-kit-sync-lock.db"), "");
      rmSync(join(folder, "notes", "marker"));

      expect(seededTreeProblems(root, SEED)).toEqual([
        '  seeded folder .pi/agent/intercom entries differ: expected ["config.json","notes","notes/marker"] actual [".docks-kit-sync-lock.db","config.json","notes"]',
        "  seeded file .pi/agent/intercom/notes/marker is missing",
      ]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "reports each missing file when one name with a line break joins like two expected names",
    () => {
      withSnapshotRoot((root) => {
        const seed: SeededTree = { root: "seeded", files: { a: "first\n", b: "second\n" } };
        writeSeededTree(root, seed);
        const folder = join(root, "seeded");
        rmSync(join(folder, "a"));
        rmSync(join(folder, "b"));
        writeFileSync(join(folder, "a\nb"), "joined\n");

        expect(seededTreeProblems(root, seed)).toEqual([
          '  seeded folder seeded entries differ: expected ["a","b"] actual ["a\\nb"]',
          "  seeded file seeded/a is missing",
          "  seeded file seeded/b is missing",
        ]);
      });
    },
  );

  it("reports a seeded folder that the run removed", () => {
    withSnapshotRoot((root) => {
      writeSeededTree(root, SEED);
      rmSync(join(root, ".pi"), { recursive: true });

      expect(seededTreeProblems(root, SEED)).toEqual([
        "  seeded folder .pi/agent/intercom is missing",
      ]);
    });
  });
});

describe("snapshotTree", () => {
  it("hashes binary CRLF bytes without text normalization", () => {
    withSnapshotRoot((root) => {
      writeFileSync(join(root, "with-crlf.mp3"), Buffer.from([0x61, 0x0d, 0x0a, 0x62]));
      writeFileSync(join(root, "with-lf.mp3"), Buffer.from([0x61, 0x0a, 0x62]));

      const tree = snapshotTree(root);
      expect(tree["with-crlf.mp3"]).not.toBe(tree["with-lf.mp3"]);
    });
  });

  it("still canonicalizes CRLF in explicitly textual artifacts", () => {
    withSnapshotRoot((root) => {
      writeFileSync(join(root, "with-crlf.txt"), "a\r\nb");
      writeFileSync(join(root, "with-lf.txt"), "a\nb");

      const tree = snapshotTree(root);
      expect(tree["with-crlf.txt"]).toBe(tree["with-lf.txt"]);
    });
  });

  it("normalizes absolute symlink targets under the snapshot home", () => {
    withSnapshotRoot((root) => {
      mkdirSync(join(root, "links"));
      symlinkSync(join(root, "destination"), join(root, "links", "current"));

      expect(snapshotTree(root)["links/current"]).toBe("link:<HOME>/destination");
    });
  });
});
