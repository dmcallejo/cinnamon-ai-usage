const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/kimi-usage.json");
const {appletRequire, gettext: _} = require("./helpers");

const util = appletRequire("lib/util.js");
const {ErrorKind, ProviderError} = appletRequire("lib/errors.js");
const {KimiProvider, parseUsage} = appletRequire("providers/kimi.js");

const HOME = "/home/tester";
const VALID_CREDENTIALS = {
    access_token: "kimi-token",
    refresh_token: "r",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    scope: "kimi-code",
    token_type: "Bearer",
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
    return {provider: new KimiProvider(ctx), calls};
}

async function assertProviderError(promise, kind) {
    await assert.rejects(promise, (e) => e instanceof ProviderError && e.kind === kind);
}

test("counters win over ratios stuck at zero (upstream bug)", () => {
    const usage = parseUsage(fixture, _, util);
    assert.deepEqual(usage.limits.map((l) => [l.id, l.label, l.percent]), [
        ["limit_5h", "5-hour limit", 88],
        ["limit_7d", "Weekly limit", 29],
    ]);
    assert.equal(usage.limits[0].resetsAt.toISOString(), "2026-10-01T01:58:51.471Z");
    assert.equal(usage.plan, null);
});

test("ratios are used when they are the only data, monthly windows included", () => {
    const usage = parseUsage({usages: {
        limit_5h: {used_ratio: 0.42, reset_time: "2026-11-18T12:00:00Z"},
        limit_month_total: {used_ratio: "0.0306", reset_time: "2026-12-01T00:00:00Z"},
        limit_month_code: {used_ratio: 0.1},
    }, user: {membership: {user_level_name: "Max"}}}, _, util);
    assert.deepEqual(usage.limits.map((l) => [l.id, l.label, Math.round(l.percent * 100) / 100]), [
        ["limit_5h", "5-hour limit", 42],
        ["limit_month_code", "Monthly, Kimi Code", 10],
        ["limit_month_total", "Monthly, all Kimi usage", 3.06],
    ]);
    assert.equal(usage.plan, "Max");
});

test("the wrapped camelCase shape is understood", () => {
    const usage = parseUsage({code: 0, data: {kind: "ok", quota: {extraUsage: null, usages: {
        limit5h: {resetAt: "2026-09-18T12:07:12Z", usedRatio: 0.17},
        limit7d: {resetAt: "2026-09-23T23:07:12Z", usedRatio: 0.35},
    }}}}, _, util);
    assert.deepEqual(usage.limits.map((l) => [l.id, Math.round(l.percent)]), [["limit_5h", 17], ["limit_7d", 35]]);
});

test("counters accept remaining-only data and ignore other windows", () => {
    const usage = parseUsage({limits: [
        {window: {duration: 5, timeUnit: "TIME_UNIT_HOUR"}, detail: {limit: "200", remaining: "150"}},
        {window: {duration: 1, timeUnit: "TIME_UNIT_MINUTE"}, detail: {limit: "10", used: "9"}},
    ]}, _, util);
    assert.deepEqual(usage.limits.map((l) => [l.id, l.percent]), [["limit_5h", 25]]);
});

test("booster wallet spending is shown when a monthly cap is set", () => {
    const usage = parseUsage({
        usages: {limit_5h: {used_ratio: 0.1}},
        boosterWallet: {
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimit: {priceInCents: "5000", currency: "CNY"},
            monthlyUsed: {priceInCents: "1250", currency: "CNY"},
        },
    }, _, util);
    assert.deepEqual(usage.spend, {label: "Extra usage", used: 12.5, limit: 50, currency: "CNY", percent: 25});
    assert.equal(parseUsage({usages: {limit_5h: {used_ratio: 0}}, boosterWallet: {monthlyChargeLimitEnabled: false}}, _, util).spend, null);
});

test("fetch reads the Kimi Code sign-in and calls the usages endpoint", async () => {
    const {provider, calls} = makeProvider();
    const result = await provider.fetch(null);
    assert.equal(result.limits.length, 2);
    assert.equal(calls.read[0], `${HOME}/.kimi-code/credentials/kimi-code.json`);
    assert.equal(calls.http[0].url, "https://api.kimi.com/coding/v1/usages");
    assert.equal(calls.http[0].headers.Authorization, "Bearer kimi-token");
});

test("paths and base URL honour settings and environment", () => {
    assert.equal(makeProvider({settings: {"credentials-path": "~/k.json"}}).provider.credentialsPath(), `${HOME}/k.json`);
    assert.equal(makeProvider({env: {KIMI_CODE_HOME: "/kh"}}).provider.credentialsPath(), "/kh/credentials/kimi-code.json");
    assert.equal(makeProvider({env: {KIMI_CODE_BASE_URL: "https://api.kimi.ai/coding/v1/"}}).provider.usageUrl(), "https://api.kimi.ai/coding/v1/usages");
    assert.deepEqual(makeProvider().provider.watchPaths(), [`${HOME}/.kimi-code/credentials/kimi-code.json`]);
});

test("missing file means not signed in; bad files are config errors", async () => {
    const readError = Object.assign(new Error("nope"), {code: "ENOENT"});
    await assertProviderError(makeProvider({readError}).provider.fetch(null), ErrorKind.NOT_FOUND);
    await assertProviderError(makeProvider({credentials: {refresh_token: "x"}}).provider.fetch(null), ErrorKind.CONFIG);
});

test("expired token (seconds or milliseconds) is reported without calling the API", async () => {
    for (const expires_at of [Math.floor(Date.now() / 1000) - 10, Date.now() - 10000]) {
        const {provider, calls} = makeProvider({credentials: {access_token: "t", expires_at}});
        await assertProviderError(provider.fetch(null), ErrorKind.AUTH);
        assert.equal(calls.http.length, 0);
    }
});

test("HTTP errors and in-band errors map to error kinds", async () => {
    await assertProviderError(makeProvider({response: {status: 401, json: null}}).provider.fetch(null), ErrorKind.AUTH);
    await assertProviderError(makeProvider({response: {status: 429, json: null}}).provider.fetch(null), ErrorKind.RATE_LIMITED);
    await assertProviderError(makeProvider({response: {status: 404, json: null}}).provider.fetch(null), ErrorKind.SERVER);
    await assertProviderError(makeProvider({response: {status: 200, json: {data: {kind: "error", message: "x"}}}}).provider.fetch(null), ErrorKind.SERVER);
    await assertProviderError(makeProvider({response: {status: 200, json: {}}}).provider.fetch(null), ErrorKind.SERVER);
});
