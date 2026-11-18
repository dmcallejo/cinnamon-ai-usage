const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/codex-usage.json");
const {appletRequire, gettext: _} = require("./helpers");

const util = appletRequire("lib/util.js");
const {ErrorKind, ProviderError} = appletRequire("lib/errors.js");
const {CodexProvider, parseUsage} = appletRequire("providers/codex.js");

const HOME = "/home/tester";
const VALID_AUTH = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {access_token: "token-abc", refresh_token: "r", id_token: "i", account_id: "acct-1"},
};

function makeProvider({auth = VALID_AUTH, response, readError, env = {}, settings = {}} = {}) {
    const calls = {read: [], http: []};
    const ctx = {
        _,
        util,
        ErrorKind,
        ProviderError,
        homeDir: HOME,
        getenv: (name) => env[name] || null,
        getSetting: (key) => settings[key],
        readJSON: async (path) => {
            calls.read.push(path);
            if (readError)
                throw readError;
            return auth;
        },
        http: {
            getJSON: async (url, headers) => {
                calls.http.push({url, headers});
                return response || {status: 200, json: fixture};
            },
        },
    };
    return {provider: new CodexProvider(ctx), calls};
}

async function assertProviderError(promise, kind) {
    await assert.rejects(promise, (e) => e instanceof ProviderError && e.kind === kind);
}

test("parseUsage reads the 5-hour and weekly windows", () => {
    const usage = parseUsage(fixture, _, util);
    assert.equal(usage.plan, "plus");
    assert.deepEqual(usage.limits.map((l) => [l.id, l.label, l.percent]), [
        ["codex:primary_window", "5-hour limit", 66],
        ["codex:secondary_window", "Weekly limit", 10],
    ]);
    assert.equal(usage.limits[0].resetsAt.getTime(), 1795008218 * 1000);
});

test("parseUsage reports when the server blocks requests", () => {
    assert.equal(parseUsage(fixture, _, util).blocked, false);
    const reached = {rate_limit: Object.assign({}, fixture.rate_limit, {allowed: false, limit_reached: true})};
    assert.equal(parseUsage(reached, _, util).blocked, true);
});

test("parseUsage never exposes account identity", () => {
    const text = JSON.stringify(parseUsage(fixture, _, util));
    assert.doesNotMatch(text, /someone@example\.com|user-REDACTED|00000000-0000/);
});

test("parseUsage falls back to reset_after_seconds and labels odd windows", () => {
    const now = Date.UTC(2026, 0, 1);
    const usage = parseUsage({rate_limit: {primary_window: {
        used_percent: 5, limit_window_seconds: 3 * 3600, reset_after_seconds: 60,
    }}}, _, util, now);
    assert.equal(usage.limits[0].label, "3h 00m limit");
    assert.equal(usage.limits[0].resetsAt.getTime(), now + 60 * 1000);
});

test("parseUsage includes code review and additional limits", () => {
    const window = {used_percent: 40, limit_window_seconds: 604800, reset_at: 1};
    const usage = parseUsage({
        rate_limit: {primary_window: {used_percent: 1, limit_window_seconds: 18000, reset_at: 1}},
        code_review_rate_limit: {primary_window: window},
        additional_rate_limits: [{limit_name: "cloud_tasks", rate_limit: {primary_window: window}}, null, {}],
    }, _, util);
    assert.deepEqual(usage.limits.map((l) => l.label), [
        "5-hour limit",
        "Code review, Weekly limit",
        "Cloud tasks, Weekly limit",
    ]);
});

test("parseUsage tolerates bad bodies", () => {
    assert.deepEqual(parseUsage(null, _, util), {plan: null, limits: [], blocked: false});
    assert.deepEqual(parseUsage({rate_limit: {primary_window: {used_percent: null}}}, _, util).limits, []);
});

test("fetch sends the token and account id", async () => {
    const {provider, calls} = makeProvider();
    const result = await provider.fetch(null);
    assert.equal(result.plan, "Plus");
    assert.equal(result.spend, null);
    assert.equal(calls.read[0], `${HOME}/.codex/auth.json`);
    assert.equal(calls.http[0].url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(calls.http[0].headers.Authorization, "Bearer token-abc");
    assert.equal(calls.http[0].headers["ChatGPT-Account-Id"], "acct-1");
});

test("auth path honours setting and CODEX_HOME, and is watched", () => {
    assert.equal(makeProvider({settings: {"auth-path": "~/a.json"}}).provider.authPath(), `${HOME}/a.json`);
    assert.equal(makeProvider({env: {CODEX_HOME: "/cx"}}).provider.authPath(), "/cx/auth.json");
    assert.deepEqual(makeProvider().provider.watchPaths(), [`${HOME}/.codex/auth.json`]);
});

test("missing file means not signed in; API key sign-ins are config errors", async () => {
    const readError = Object.assign(new Error("nope"), {code: "ENOENT"});
    await assertProviderError(makeProvider({readError}).provider.fetch(null), ErrorKind.NOT_FOUND);
    const apiKeyOnly = {auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null};
    const {provider, calls} = makeProvider({auth: apiKeyOnly});
    await assertProviderError(provider.fetch(null), ErrorKind.CONFIG);
    assert.equal(calls.http.length, 0);
});

test("HTTP errors map to error kinds", async () => {
    await assertProviderError(makeProvider({response: {status: 401, json: null}}).provider.fetch(null), ErrorKind.AUTH);
    await assertProviderError(makeProvider({response: {status: 429, json: null}}).provider.fetch(null), ErrorKind.RATE_LIMITED);
    await assertProviderError(makeProvider({response: {status: 502, json: null}}).provider.fetch(null), ErrorKind.SERVER);
    await assertProviderError(makeProvider({response: {status: 200, json: {}}}).provider.fetch(null), ErrorKind.SERVER);
});
