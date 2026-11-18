const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/anthropic-usage.json");
const {appletRequire, gettext: _} = require("./helpers");

const util = appletRequire("lib/util.js");
const {ErrorKind, ProviderError} = appletRequire("lib/errors.js");
const {AnthropicProvider, parseUsage} = appletRequire("providers/anthropic.js");

const HOME = "/home/tester";
const VALID_CREDENTIALS = {
    claudeAiOauth: {
        accessToken: "token-123",
        expiresAt: Date.now() + 3600 * 1000,
        subscriptionType: "max",
    },
};

function makeProvider({credentials = VALID_CREDENTIALS, response, readError, env = {}, settings = {}} = {}) {
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
            return credentials;
        },
        http: {
            getJSON: async (url, headers) => {
                calls.http.push({url, headers});
                return response || {status: 200, json: fixture};
            },
        },
    };
    return {provider: new AnthropicProvider(ctx), calls};
}

async function assertProviderError(promise, kind) {
    await assert.rejects(promise, (e) => e instanceof ProviderError && e.kind === kind);
}

test("parseUsage prefers the limits array", () => {
    const usage = parseUsage(fixture, _, util);
    assert.deepEqual(usage.limits.map((l) => [l.id, l.label, l.percent]), [
        ["session", "Current session", 42],
        ["weekly_all", "Weekly, all models", 19],
    ]);
    assert.equal(usage.limits[0].resetsAt.toISOString(), "2026-11-17T13:40:00.051Z");
    assert.deepEqual(usage.spend, {label: "Extra usage", used: 12.5, limit: 50, currency: "USD", percent: 25});
});

test("parseUsage falls back to legacy windows", () => {
    const {limits: _limits, spend: _spend, ...legacy} = fixture;
    const usage = parseUsage(legacy, _, util);
    assert.deepEqual(usage.limits.map((l) => [l.id, l.percent]), [["session", 42], ["weekly_all", 19]]);
    assert.equal(usage.spend.used, 12.5);
    assert.equal(usage.spend.limit, 50);
});

test("parseUsage labels unknown and scoped limits", () => {
    const usage = parseUsage({limits: [
        {kind: "weekly_cowork", percent: 5},
        {kind: "weekly_all", percent: 7, scope: "Design"},
        {kind: "broken"},
    ]}, _, util);
    assert.deepEqual(usage.limits.map((l) => [l.id, l.label]), [
        ["weekly_cowork", "Weekly cowork"],
        ["weekly_all:Design", "Weekly, all models (Design)"],
    ]);
});

test("parseUsage ignores disabled spend and bad bodies", () => {
    assert.equal(parseUsage({limits: [], spend: {enabled: false}}, _, util).spend, null);
    assert.deepEqual(parseUsage(null, _, util), {limits: [], spend: null});
});

test("fetch sends the token to the usage endpoint", async () => {
    const {provider, calls} = makeProvider();
    const result = await provider.fetch(null);
    assert.equal(result.plan, "Max");
    assert.equal(result.limits.length, 2);
    assert.equal(calls.read[0], `${HOME}/.claude/.credentials.json`);
    assert.equal(calls.http[0].url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(calls.http[0].headers.Authorization, "Bearer token-123");
});

test("credentials path honours setting and CLAUDE_CONFIG_DIR", () => {
    assert.equal(makeProvider({settings: {"credentials-path": "~/c.json"}}).provider.credentialsPath(), `${HOME}/c.json`);
    assert.equal(makeProvider({env: {CLAUDE_CONFIG_DIR: "/cfg"}}).provider.credentialsPath(), "/cfg/.credentials.json");
});

test("watches the credentials file so renewals are picked up at once", () => {
    assert.deepEqual(makeProvider().provider.watchPaths(), [`${HOME}/.claude/.credentials.json`]);
    assert.deepEqual(makeProvider({settings: {"credentials-path": "/x/c.json"}}).provider.watchPaths(), ["/x/c.json"]);
});

test("missing credentials file is a config error", async () => {
    const readError = Object.assign(new Error("nope"), {code: "ENOENT"});
    const {provider, calls} = makeProvider({readError});
    await assertProviderError(provider.fetch(null), ErrorKind.CONFIG);
    assert.equal(calls.http.length, 0);
});

test("credentials without a subscription sign-in are a config error", async () => {
    const {provider} = makeProvider({credentials: {mcpOAuth: {}}});
    await assertProviderError(provider.fetch(null), ErrorKind.CONFIG);
});

test("expired token is reported without calling the API", async () => {
    const credentials = {claudeAiOauth: {accessToken: "t", expiresAt: Date.now() - 1000}};
    const {provider, calls} = makeProvider({credentials});
    await assertProviderError(provider.fetch(null), ErrorKind.AUTH);
    assert.equal(calls.http.length, 0);
});

test("HTTP errors map to error kinds", async () => {
    await assertProviderError(makeProvider({response: {status: 401, json: null}}).provider.fetch(null), ErrorKind.AUTH);
    await assertProviderError(makeProvider({response: {status: 429, json: null}}).provider.fetch(null), ErrorKind.RATE_LIMITED);
    await assertProviderError(makeProvider({response: {status: 500, json: null}}).provider.fetch(null), ErrorKind.SERVER);
    await assertProviderError(makeProvider({response: {status: 200, json: {}}}).provider.fetch(null), ErrorKind.SERVER);
});
