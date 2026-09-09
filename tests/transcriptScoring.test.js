const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseScorePayload } = require("../lib/transcriptScoring");

test("transcript scores accept bounded JSON and keep a concise rationale", () => {
  assert.deepEqual(
    parseScorePayload('```json\n{"score":82.4,"rationale":"Direct and specific."}\n```'),
    { score: 82, rationale: "Direct and specific." }
  );
});

test("transcript scores reject missing or out-of-range model values", () => {
  assert.throws(() => parseScorePayload('{"score":101,"rationale":"Invalid."}'), /invalid transcript score/i);
  assert.throws(() => parseScorePayload('{"score":70,"rationale":""}'), /without an explanation/i);
});
