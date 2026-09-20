import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { summarizeTurnFileChanges } = await import(
  "../src/lib/turn-file-summary.ts"
);

const message = (id, role, extra = {}) => ({
  id,
  role,
  content: "",
  createdAt: "2026-09-20T00:00:00.000Z",
  ...extra,
});

const review = (snapshotId, path, extra = {}) => ({
  version: 1,
  snapshotId,
  messageId: `message-${snapshotId}`,
  path,
  operation: "edit",
  status: "modified",
  state: "active",
  additions: 2,
  deletions: 1,
  hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "next" }] }],
  reversible: true,
  ...extra,
});

const tool = (id, toolName, details, extra = {}) =>
  message(id, "tool", {
    toolName,
    toolStatus: "success",
    toolCallId: `call-${id}`,
    toolResult: { details },
    ...extra,
  });

const turnEntries = (messages) =>
  buildTranscriptEntries(messages).entries.filter(
    (entry) => entry.kind === "assistant-turn",
  );

const workspaceEdit = (id, snapshotId, path, extraReview = {}, extraMessage = {}) =>
  tool(
    id,
    "Edit",
    { root: "workspace", review: review(snapshotId, path, extraReview) },
    extraMessage,
  );

const shell = (id, reviews, capture = "complete", extra = {}) =>
  tool(
    id,
    "Bash",
    {
      root: "workspace",
      exitCode: 0,
      reviews,
      reviewCapture: { status: capture },
    },
    extra,
  );

test("visual turns are summarized independently without round contamination", () => {
  const [first, second] = turnEntries([
    message("user-1", "user"),
    workspaceEdit("edit-1", "snapshot-1", "src/first.ts"),
    message("answer-1", "assistant", { content: "First done" }),
    message("user-2", "user"),
    shell("shell-2", [review("snapshot-2", "src/second.ts")]),
    message("answer-2", "assistant", { content: "Second done" }),
  ]);

  assert.deepEqual(
    summarizeTurnFileChanges(first).files.map((file) => file.path),
    ["src/first.ts"],
  );
  assert.deepEqual(
    summarizeTurnFileChanges(second).files.map((file) => file.path),
    ["src/second.ts"],
  );
});

test("screenshot workflow records the three Bash-copied workspace files", () => {
  const failedWrite = tool(
    "workspace-write",
    "Write",
    { root: "workspace", review: review("failed-write", "index.html") },
    { toolStatus: "error" },
  );
  const scratchWrite = tool("scratch-write", "Write", {
    root: "scratch",
    review: review("scratch-write", "index.html"),
  });
  const copied = shell("copy-files", [
    review("shell-html", "index.html", { additions: 20, deletions: 0 }),
    review("shell-css", "styles.css", { additions: 12, deletions: 0 }),
    review("shell-js", "app.js", { additions: 8, deletions: 0 }),
  ]);
  const [entry] = turnEntries([
    failedWrite,
    scratchWrite,
    copied,
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 3);
  assert.equal(summary.operationCount, 3);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["app.js", "styles.css", "index.html"],
  );
  assert.equal(summary.hasCompleteCapture, true);
  assert.equal(summary.hasUnavailableCapture, false);
});

test("repeated paths group operations and dedupe repeated snapshots", () => {
  const [entry] = turnEntries([
    workspaceEdit("early", "snapshot-early", "src/repeated.ts", {
      additions: 3,
      deletions: 0,
    }),
    shell("copy", [
      review("snapshot-other", "src/other.ts", { additions: 1, deletions: 4 }),
      review("snapshot-late", "src/repeated.ts", { additions: 5, deletions: 2 }),
      review("snapshot-late", "src/repeated.ts", { additions: 6, deletions: 2 }),
    ]),
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 2);
  assert.equal(summary.operationCount, 3);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["src/repeated.ts", "src/other.ts"],
  );
  assert.deepEqual(
    summary.files[0].entries.map((record) => record.change.snapshotId),
    ["snapshot-late", "snapshot-early"],
  );
  assert.deepEqual([summary.additions, summary.deletions], [10, 6]);
});

test("failed Bash still contributes valid captured mutations", () => {
  const [entry] = turnEntries([
    shell(
      "failed-shell",
      [review("failed-shell-change", "partial-output.html")],
      "partial",
      { toolStatus: "error" },
    ),
    message("answer", "assistant", { content: "Command failed" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 1);
  assert.equal(summary.files[0].path, "partial-output.html");
  assert.equal(summary.hasPartialCapture, true);
});

test("complete no-change shell captures do not create an empty summary", () => {
  const [entry] = turnEntries([
    shell("read-only", []),
    message("answer", "assistant", { content: "No changes" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 0);
  assert.equal(summary.hasCompleteCapture, true);
  assert.equal(summary.hasPartialCapture, false);
  assert.equal(summary.hasUnavailableCapture, false);
});

test("partial and legacy shell scope remain visible without invented files", () => {
  const [partialEntry] = turnEntries([
    shell("partial", [], "partial"),
    message("partial-answer", "assistant", { content: "Partial" }),
  ]);
  const [legacyEntry] = turnEntries([
    tool("legacy", "Bash", { exitCode: 0 }),
    message("legacy-answer", "assistant", { content: "Legacy" }),
  ]);

  assert.equal(summarizeTurnFileChanges(partialEntry).hasPartialCapture, true);
  assert.equal(summarizeTurnFileChanges(legacyEntry).hasUnavailableCapture, true);
  assert.equal(summarizeTurnFileChanges(legacyEntry).fileCount, 0);
});

test("rolled-back records stay visible but leave active totals", () => {
  const [entry] = turnEntries([
    shell("changes", [
      review("snapshot-rolled", "src/a.ts", {
        state: "rolledBack",
        additions: 8,
        deletions: 3,
      }),
      review("snapshot-active", "src/a.ts", { additions: 2, deletions: 1 }),
    ]),
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.operationCount, 2);
  assert.equal(summary.activeOperationCount, 1);
  assert.equal(summary.rolledBackOperationCount, 1);
  assert.deepEqual([summary.additions, summary.deletions], [2, 1]);
});

test("binary and truncated records remain available without line hunks", () => {
  const [entry] = turnEntries([
    shell("binary-shell", [
      review("snapshot-binary", "asset.bin", {
        binary: true,
        hunks: [],
        additions: 0,
        deletions: 0,
      }),
      review("snapshot-large", "generated.txt", {
        truncated: true,
        hunks: [],
        additions: 100,
        deletions: 20,
      }),
    ]),
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.files.find((file) => file.path === "asset.bin").entries[0].change.binary, true);
  assert.equal(summary.files.find((file) => file.path === "generated.txt").entries[0].change.truncated, true);
});

test("nested delegate edits remain excluded from parent rollback groups", () => {
  const task = tool("task", "Task", { status: "running" });
  const nestedShell = shell(
    "nested-shell",
    [review("snapshot-nested", "src/delegate.ts")],
    "complete",
    { parentToolCallId: "call-task", agentName: "worker" },
  );
  const [entry] = turnEntries([
    task,
    nestedShell,
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 0);
  assert.equal(summary.hasBashTool, false);
  assert.equal(summary.hasExcludedSubagentEdits, true);
});
