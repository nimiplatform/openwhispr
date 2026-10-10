const test = require("node:test");
const assert = require("node:assert/strict");
const { captureNimiHostWarnings } = require("../../src/helpers/nimiHostWarnings");

test("existing invalidation warning reaches only bounded App diagnostics and still forwards", () => {
  const logs = [],
    forwarded = [];
  const original = (...args) => forwarded.push(args);
  const target = { warn: original };
  const restore = captureNimiHostWarnings({ warn: (...args) => logs.push(args) }, target);
  target.warn("[nimi-shell] local App session invalidated", {
    method: "localAppScenarioJobStreamNext",
    reasonCode: "declared-test-reason",
    retryable: false,
    credential: "must never be captured",
  });
  assert.deepEqual(logs[0][1], {
    method: "localAppScenarioJobStreamNext",
    reasonCode: "declared-test-reason",
    retryable: false,
  });
  assert.equal(forwarded.length, 1);
  target.warn("unrelated warning", { private: "not copied" });
  assert.equal(logs.length, 1);
  restore();
  assert.equal(target.warn, original);
});
test("a logging failure cannot change the original warning or session path", () => {
  let forwarded = 0;
  const target = {
    warn: () => {
      forwarded++;
    },
  };
  captureNimiHostWarnings(
    {
      warn: () => {
        throw new Error("declared log failure");
      },
    },
    target
  );
  target.warn("[nimi-shell] local App session maintenance paused", {
    reasonCode: "declared-test-reason",
    retryable: true,
  });
  assert.equal(forwarded, 1);
});
