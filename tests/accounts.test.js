const test = require("node:test");
const assert = require("node:assert/strict");
const {appletRequire} = require("./helpers");

const util = appletRequire("lib/util.js");
const {parseAccounts} = appletRequire("lib/accounts.js");

const OPTIONS = {homeDir: "/home/me", expandHome: util.expandHome, defaultName: (i) => `Account ${i + 2}`};

test("enabled rows become accounts with unique keys", () => {
    const accounts = parseAccounts("anthropic", [
        {name: "Work", folder: "~/.claude-work", icon: "", enabled: true},
        {name: "Personal", folder: "file:///home/me/.claude%20personal/", icon: "face", enabled: true},
        {name: "Off", folder: "/x", enabled: false},
        {name: "work", folder: "/y"},
    ], OPTIONS);
    assert.deepEqual(accounts, [
        {key: "anthropic:work", name: "Work", folder: "/home/me/.claude-work", icon: ""},
        {key: "anthropic:personal", name: "Personal", folder: "/home/me/.claude personal", icon: "face"},
        {key: "anthropic:work-", name: "work", folder: "/y", icon: ""},
    ]);
});

test("missing name falls back to the folder, missing folder is kept empty", () => {
    const accounts = parseAccounts("codex", [{folder: "/srv/codex-team"}, {name: ""}], OPTIONS);
    assert.deepEqual(accounts.map((a) => [a.key, a.name, a.folder]), [
        ["codex:codex-team", "codex-team", "/srv/codex-team"],
        ["codex:account-3", "Account 3", ""],
    ]);
});

test("bad values are ignored", () => {
    assert.deepEqual(parseAccounts("kimi", null, OPTIONS), []);
    assert.deepEqual(parseAccounts("kimi", [null, 5, "x"], OPTIONS), []);
});
