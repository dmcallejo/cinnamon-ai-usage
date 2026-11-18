const test = require("node:test");
const assert = require("node:assert/strict");
const {appletRequire} = require("./helpers");

const util = appletRequire("lib/util.js");
const {panelSegments, worstSeverity, usageIncreased} = appletRequire("lib/panel.js");

const PROVIDERS = [
    {id: "anthropic", limits: [{percent: 13, resetsAt: "s"}, {percent: 21, resetsAt: "w"}]},
    {id: "codex", limits: [{percent: 71, resetsAt: "5h"}, {percent: 11, resetsAt: "wk"}]},
];

const options = (extra = {}) => Object.assign({
    showReset: true,
    compact: false,
    severity: (p) => util.severityFor(p, 75, 90),
    resetText: (limit) => `in ${limit.resetsAt}`,
    formatPercent: util.formatPercent,
}, extra);

test("highest shows the provider of the highest limit, with its reset", () => {
    assert.deepEqual(panelSegments(PROVIDERS, "highest", options()), [
        {providerId: "codex", text: "71% · in 5h", severity: "normal"},
    ]);
});

test("primary shows one icon per provider with its first limit", () => {
    assert.deepEqual(panelSegments(PROVIDERS, "primary", options()).map((s) => [s.providerId, s.text]), [
        ["anthropic", "13%"],
        ["codex", "71%"],
    ]);
});

test("all groups every limit behind its provider icon", () => {
    assert.deepEqual(panelSegments(PROVIDERS, "all", options()).map((s) => [s.providerId, s.text]), [
        ["anthropic", "13% · 21%"],
        ["codex", "71% · 11%"],
    ]);
});

test("icon mode keeps icons and severity but no text", () => {
    const hot = [{id: "codex", limits: [{percent: 95}, {percent: 80}]}];
    assert.deepEqual(panelSegments(hot, "icon", options()), [
        {providerId: "codex", text: "", severity: "critical"},
    ]);
});

test("compact keeps only the highest percentage per icon", () => {
    assert.deepEqual(panelSegments(PROVIDERS, "all", options({compact: true})).map((s) => s.text), ["21%", "71%"]);
});

test("reset is omitted when disabled or unknown", () => {
    assert.equal(panelSegments(PROVIDERS, "highest", options({showReset: false}))[0].text, "71%");
    assert.equal(panelSegments(PROVIDERS, "highest", options({resetText: () => ""}))[0].text, "71%");
});

test("no providers means no segments", () => {
    assert.deepEqual(panelSegments([], "highest", options()), []);
    assert.equal(worstSeverity([]), "normal");
});

test("usageIncreased only counts rises of limits seen before", () => {
    const snap = (...pairs) => ({limits: pairs.map(([id, percent]) => ({id, percent}))});
    assert.equal(usageIncreased(null, snap(["a", 10])), false);
    assert.equal(usageIncreased(snap(["a", 10]), snap(["a", 10])), false);
    assert.equal(usageIncreased(snap(["a", 10]), snap(["a", 12])), true);
    assert.equal(usageIncreased(snap(["a", 90]), snap(["a", 0])), false);
    assert.equal(usageIncreased(snap(["a", 10]), snap(["a", 5], ["b", 50])), false);
    assert.equal(usageIncreased(snap(["a", 10], ["b", 1]), snap(["a", 5], ["b", 2])), true);
});
