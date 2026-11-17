const test = require("node:test");
const assert = require("node:assert/strict");
const {appletRequire, gettext: _} = require("./helpers");

const util = appletRequire("lib/util.js");

test("clampPercent bounds and rejects non numbers", () => {
    assert.equal(util.clampPercent(42.5), 42.5);
    assert.equal(util.clampPercent(-3), 0);
    assert.equal(util.clampPercent(140), 100);
    assert.equal(util.clampPercent("17"), 17);
    assert.equal(util.clampPercent(null), null);
    assert.equal(util.clampPercent(undefined), null);
    assert.equal(util.clampPercent("abc"), null);
});

test("severityFor uses thresholds and tolerates swapped values", () => {
    assert.equal(util.severityFor(10, 75, 90), "normal");
    assert.equal(util.severityFor(75, 75, 90), "warning");
    assert.equal(util.severityFor(95, 75, 90), "critical");
    assert.equal(util.severityFor(80, 90, 75), "warning");
    assert.equal(util.severityFor(null, 75, 90), "normal");
});

test("formatDuration is compact", () => {
    const min = 60 * 1000;
    assert.equal(util.formatDuration(-5, _), "now");
    assert.equal(util.formatDuration(30 * 1000, _), "<1m");
    assert.equal(util.formatDuration(45 * min, _), "45m");
    assert.equal(util.formatDuration(125 * min, _), "2h 05m");
    assert.equal(util.formatDuration((3 * 24 * 60 + 4 * 60 + 59) * min, _), "3d 4h");
});

test("formatMoney falls back without Intl support for the currency", () => {
    assert.match(util.formatMoney(2.05, "EUR"), /2[.,]05/);
    assert.equal(util.formatMoney(2, "NOT-A-CURRENCY"), "2.00 NOT-A-CURRENCY");
});

test("expandHome and humanize", () => {
    assert.equal(util.expandHome("~/x/y", "/home/me"), "/home/me/x/y");
    assert.equal(util.expandHome("/abs", "/home/me"), "/abs");
    assert.equal(util.humanize("weekly_oauth_apps"), "Weekly oauth apps");
    assert.equal(util.capitalize("team"), "Team");
});

test("parseDate rejects garbage", () => {
    assert.equal(util.parseDate("nope"), null);
    assert.equal(util.parseDate(null), null);
    assert.equal(util.parseDate("2026-01-01T00:00:00Z").toISOString(), "2026-01-01T00:00:00.000Z");
});
