import assert from "node:assert/strict";
import test from "node:test";

import { extractJsonObject } from "../dist/openclaw-process.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";

test("ShareX/ShareX profile is review-only and WinForms/Avalonia aware", () => {
  const profile = repositoryProfileFor("ShareX/ShareX");
  assert.equal(profile.targetRepo, "sharex/sharex");
  assert.equal(profile.slug, "sharex-sharex");
  assert.equal(profile.displayName, "ShareX");
  assert.equal(profile.checkoutDir, "sharex");
  assert.deepEqual(profile.applyCloseRules, { issue: [], pull_request: [] });
  assert.match(profile.promptNote, /develop/i);
  assert.match(profile.promptNote, /Windows Forms/i);
  assert.match(profile.promptNote, /Avalonia/i);
  assert.match(profile.promptNote, /Review only/i);
});

test("extractJsonObject unwraps fenced JSON and prose around model output", () => {
  assert.deepEqual(JSON.parse(extractJsonObject('{"decision":"keep_open"}')), {
    decision: "keep_open",
  });
  assert.deepEqual(
    JSON.parse(
      extractJsonObject(
        'Here is the review:\n```json\n{"decision":"close","note":"a {b} c"}\n```\nDone.',
      ),
    ),
    { decision: "close", note: "a {b} c" },
  );
  assert.deepEqual(
    JSON.parse(
      extractJsonObject(
        'Summary first.\n{"decision":"keep_open","nested":{"x":1}}\nTrailing text.',
      ),
    ),
    { decision: "keep_open", nested: { x: 1 } },
  );
  assert.equal(extractJsonObject("not json at all"), "not json at all");
});
