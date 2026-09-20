import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  reviewChangeFromMessage,
  reviewChangesFromMessage,
  reviewChangesFromMessages,
  reviewCaptureFromMessage,
  withReviewChangeState,
} = await import("../src/lib/workspace-review.ts");

const review = (snapshotId, path, extra = {}) => ({
  version: 1,
  snapshotId,
  messageId: "shell-message",
  path,
  operation: "edit",
  status: "modified",
  state: "active",
  additions: 2,
  deletions: 1,
  hunks: [],
  reversible: true,
  ...extra,
});

const tool = (overrides = {}) => ({
  id: "shell-message",
  role: "tool",
  content: "",
  createdAt: "2026-09-20T00:00:00.000Z",
  toolName: "Bash",
  toolStatus: "success",
  toolResult: {
    details: {
      root: "workspace",
      reviews: [
        review("snapshot-html", "index.html"),
        review("snapshot-css", "styles.css"),
      ],
      reviewCapture: { status: "complete" },
    },
  },
  ...overrides,
});

test("legacy single review behavior is preserved", () => {
  const message = tool({
    toolName: "Edit",
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-legacy", "src/legacy.ts"),
      },
    },
  });

  assert.equal(reviewChangeFromMessage(message)?.snapshotId, "snapshot-legacy");
  assert.deepEqual(
    reviewChangesFromMessage(message).map((change) => change.path),
    ["src/legacy.ts"],
  );
});

test("executed Bash accepts valid reviews on success and error", () => {
  assert.deepEqual(
    reviewChangesFromMessage(tool()).map((change) => change.path),
    ["index.html", "styles.css"],
  );
  assert.deepEqual(
    reviewChangesFromMessage(tool({ toolStatus: "error" })).map(
      (change) => change.path,
    ),
    ["index.html", "styles.css"],
  );
  assert.equal(
    reviewChangesFromMessage(tool({ toolStatus: "denied" })).length,
    0,
  );
  assert.equal(
    reviewChangesFromMessage(tool({ toolStatus: "running" })).length,
    0,
  );
});

test("review records validate independently and dedupe by snapshot id", () => {
  const duplicate = review("snapshot-html", "index.html", { additions: 9 });
  const invalid = { ...review("snapshot-invalid", "bad.txt"), additions: -1 };
  const message = tool({
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-legacy", "legacy.txt"),
        reviews: [invalid, review("snapshot-html", "old.html"), duplicate],
        reviewCapture: { status: "complete" },
      },
    },
  });
  const changes = reviewChangesFromMessage(message);

  assert.deepEqual(
    changes.map((change) => change.snapshotId),
    ["snapshot-legacy", "snapshot-html"],
  );
  assert.equal(changes[1].path, "index.html");
  assert.equal(changes[1].additions, 9);

  const latest = reviewChangesFromMessages([
    message,
    tool({
      id: "later",
      toolResult: {
        details: {
          root: "workspace",
          reviews: [review("snapshot-html", "latest.html")],
          reviewCapture: { status: "complete" },
        },
      },
    }),
  ]);
  assert.equal(latest.find((entry) => entry.change.snapshotId === "snapshot-html")?.change.path, "latest.html");
});

test("capture metadata distinguishes complete, partial and legacy unavailable", () => {
  assert.equal(reviewCaptureFromMessage(tool()), "complete");
  assert.equal(
    reviewCaptureFromMessage(
      tool({
        toolResult: {
          details: {
            root: "workspace",
            reviews: [],
            reviewCapture: { status: "partial" },
          },
        },
      }),
    ),
    "partial",
  );
  assert.equal(
    reviewCaptureFromMessage(
      tool({ toolResult: { details: { exitCode: 0 } } }),
    ),
    "unavailable",
  );
  assert.equal(reviewCaptureFromMessage(tool({ toolStatus: "denied" })), null);
});

test("rollback state updates only the requested snapshot in review and reviews", () => {
  const message = tool({
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-html", "index.html"),
        reviews: [
          review("snapshot-html", "index.html"),
          review("snapshot-css", "styles.css"),
        ],
        reviewCapture: { status: "complete" },
      },
    },
  });
  const updated = withReviewChangeState(message, "rolledBack", "snapshot-css");
  const details = updated.toolResult.details;

  assert.equal(details.review.state, "active");
  assert.equal(details.reviews[0].state, "active");
  assert.equal(details.reviews[1].state, "rolledBack");
  assert.equal(reviewChangesFromMessage(updated)[1].state, "rolledBack");
});

test("session review history excludes nested delegate snapshots", () => {
  const parent = tool();
  const nested = tool({
    id: "nested-shell",
    parentToolCallId: "parent-task-call",
    toolResult: {
      details: {
        root: "workspace",
        reviews: [review("snapshot-nested", "delegate.ts")],
        reviewCapture: { status: "complete" },
      },
    },
  });

  assert.deepEqual(
    reviewChangesFromMessages([parent, nested]).map((entry) => entry.change.path),
    ["index.html", "styles.css"],
  );
});
