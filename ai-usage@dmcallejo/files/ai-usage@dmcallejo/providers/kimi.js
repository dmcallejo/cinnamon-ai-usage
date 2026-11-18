// Kimi Code (Moonshot AI) membership quota.
//
// Reads the sign-in that the Kimi Code CLI stores after `/login` and asks the
// same endpoint the CLI uses for its `/usage` view. The endpoint is not a
// documented public API and is known to answer in more than one shape, so the
// parser accepts all of them:
//
// - `usages`: {limit_5h, limit_7d, limit_month_total, limit_month_code}, each
//   {used_ratio (0-1), reset_time}. What the CLI itself reads.
// - `limits[]` (rolling window, e.g. 300 minutes) and `usage` (weekly), each
//   with string counters {limit, used, resetTime}. Older shape, still sent.
// - `data.quota.usages` with camelCase {usedRatio, resetAt}.
//
// Upstream bug (MoonshotAI/kimi-code#3908): `used_ratio` can stay at 0 while
// the counters in the same payload show real usage. When both are present for
// a window, the higher value is used.
//
// The token is only read, never refreshed or written.
// Providers receive every dependency through `ctx` (see CONTRIBUTING.md).

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DASHBOARD_URL = "https://www.kimi.com/code/console";

const WINDOW_ORDER = ["limit_5h", "limit_7d", "limit_month_code", "limit_month_total"];
const CAMEL_KEYS = {
    limit5h: "limit_5h",
    limit7d: "limit_7d",
    monthCode: "limit_month_code",
    monthTotal: "limit_month_total",
};

function windowLabel(key, _) {
    switch (key) {
    case "limit_5h":
        return _("5-hour limit");
    case "limit_7d":
        return _("Weekly limit");
    case "limit_month_code":
        return _("Monthly, Kimi Code");
    case "limit_month_total":
        return _("Monthly, all Kimi usage");
    default:
        return _("Usage limit");
    }
}

function toNumber(value) {
    if (typeof value === "number")
        return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

// Counter-style window {limit, used, remaining, resetTime} -> percent.
function counterPercent(detail) {
    if (!detail || typeof detail !== "object")
        return null;
    const limit = toNumber(detail.limit);
    if (!limit || limit <= 0)
        return null;
    let used = toNumber(detail.used);
    if (used === null) {
        const remaining = toNumber(detail.remaining);
        if (remaining === null)
            return null;
        used = limit - remaining;
    }
    return (used * 100) / limit;
}

function windowMinutes(window) {
    if (!window || typeof window !== "object")
        return null;
    const duration = toNumber(window.duration);
    if (duration === null)
        return null;
    switch (window.timeUnit) {
    case "TIME_UNIT_SECOND":
        return duration / 60;
    case "TIME_UNIT_MINUTE":
        return duration;
    case "TIME_UNIT_HOUR":
        return duration * 60;
    case "TIME_UNIT_DAY":
        return duration * 24 * 60;
    default:
        return null;
    }
}

// Collects {key -> {percent, resetsAt}} from every shape, keeping the higher
// percentage when a window appears more than once.
function collectWindows(body, util) {
    const windows = new Map();
    const add = (key, percent, reset) => {
        const value = util.clampPercent(percent);
        if (value === null)
            return;
        const resetsAt = util.parseDate(reset);
        const current = windows.get(key);
        if (!current || value > current.percent)
            windows.set(key, {percent: value, resetsAt: resetsAt || (current && current.resetsAt) || null});
        else if (!current.resetsAt && resetsAt)
            current.resetsAt = resetsAt;
    };

    const ratioWindows = (usages, camel) => {
        if (!usages || typeof usages !== "object")
            return;
        for (const [rawKey, entry] of Object.entries(usages)) {
            const key = camel ? CAMEL_KEYS[rawKey] : rawKey;
            if (!key || !entry || typeof entry !== "object")
                continue;
            const ratio = toNumber(camel ? entry.usedRatio : entry.used_ratio);
            if (ratio !== null)
                add(key, ratio * 100, camel ? entry.resetAt : entry.reset_time);
        }
    };

    ratioWindows(body.usages, false);
    if (body.data && body.data.quota)
        ratioWindows(body.data.quota.usages, true);

    if (Array.isArray(body.limits)) {
        for (const item of body.limits) {
            if (!item || typeof item !== "object")
                continue;
            const minutes = windowMinutes(item.window);
            const percent = counterPercent(item.detail);
            if (minutes === 300 && percent !== null)
                add("limit_5h", percent, item.detail.resetTime);
        }
    }
    const weekly = counterPercent(body.usage);
    if (weekly !== null)
        add("limit_7d", weekly, body.usage.resetTime);

    return windows;
}

// Booster wallet: pay-as-you-go spending once the quota runs out.
// Amounts are {priceInCents, currency}; see the CLI's managed-usage.ts.
function parseSpend(body, _) {
    const wallet = body.boosterWallet;
    if (!wallet || typeof wallet !== "object" || wallet.monthlyChargeLimitEnabled !== true)
        return null;
    const limitCents = toNumber(wallet.monthlyChargeLimit && wallet.monthlyChargeLimit.priceInCents);
    const usedCents = toNumber(wallet.monthlyUsed && wallet.monthlyUsed.priceInCents);
    if (!limitCents || limitCents <= 0 || usedCents === null)
        return null;
    const currency = (wallet.monthlyChargeLimit && wallet.monthlyChargeLimit.currency) ||
        (wallet.monthlyUsed && wallet.monthlyUsed.currency) || "";
    return {
        label: _("Extra usage"),
        used: usedCents / 100,
        limit: limitCents / 100,
        currency,
        percent: Math.min(100, Math.max(0, (usedCents / limitCents) * 100)),
    };
}

function parsePlan(body) {
    const user = body.user && typeof body.user === "object" ? body.user : {};
    const membership = user.membership && typeof user.membership === "object" ? user.membership : {};
    for (const value of [membership.user_level_name, user.user_level_name, body.user_level_name]) {
        if (typeof value === "string" && value)
            return value;
    }
    return null;
}

function parseUsage(body, _, util) {
    if (!body || typeof body !== "object")
        return {plan: null, limits: [], spend: null};
    const windows = collectWindows(body, util);
    const limits = WINDOW_ORDER
        .filter((key) => windows.has(key))
        .map((key) => Object.assign({id: key, label: windowLabel(key, _)}, windows.get(key)));
    return {plan: parsePlan(body), limits, spend: parseSpend(body, _)};
}

class KimiProvider {
    constructor(ctx) {
        this._ctx = ctx;
    }

    static get id() {
        return "kimi";
    }

    // Read through ctx.getSetting(); stored as "kimi-<key>" in settings-schema.json.
    static get settingKeys() {
        return ["credentials-path"];
    }

    get id() {
        return KimiProvider.id;
    }

    get name() {
        return "Kimi";
    }

    // Generic symbol in icons/; users can pick another one in the settings.
    get iconFile() {
        return "provider-kimi-symbolic.svg";
    }

    get dashboardUrl() {
        return DASHBOARD_URL;
    }

    credentialsPath() {
        const {getSetting, getenv, homeDir, util} = this._ctx;
        const custom = (getSetting("credentials-path") || "").trim();
        if (custom)
            return util.expandHome(custom, homeDir);
        const home = getenv("KIMI_CODE_HOME");
        const dataDir = home ? util.expandHome(home, homeDir) : `${homeDir}/.kimi-code`;
        return `${dataDir}/credentials/kimi-code.json`;
    }

    usageUrl() {
        const base = (this._ctx.getenv("KIMI_CODE_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
        return `${base}/usages`;
    }

    // Kimi Code rewrites this file when it renews the sign-in.
    watchPaths() {
        return [this.credentialsPath()];
    }

    async _readToken(cancellable) {
        const {_, readJSON, ErrorKind, ProviderError} = this._ctx;
        const path = this.credentialsPath();

        let credentials;
        try {
            credentials = await readJSON(path, cancellable);
        } catch (e) {
            if (e.code === "ENOENT") {
                throw new ProviderError(ErrorKind.NOT_FOUND,
                    _("No Kimi Code sign-in found at %s. Sign in with Kimi Code first.").format(path));
            }
            if (e.code === "EINVAL")
                throw new ProviderError(ErrorKind.CONFIG, _("Could not parse %s.").format(path));
            throw e;
        }

        if (!credentials || typeof credentials.access_token !== "string" || !credentials.access_token) {
            throw new ProviderError(ErrorKind.CONFIG,
                _("No Kimi Code sign-in found in %s.").format(path));
        }
        // Stored in seconds; tolerate milliseconds too.
        let expiresAt = Number(credentials.expires_at);
        if (expiresAt > 0 && expiresAt < 1e12)
            expiresAt *= 1000;
        if (expiresAt > 0 && expiresAt <= Date.now()) {
            throw new ProviderError(ErrorKind.AUTH,
                _("The Kimi Code sign-in has expired. Send a message in Kimi Code to renew it."));
        }
        return credentials.access_token;
    }

    async fetch(cancellable) {
        const {_, http, util, ErrorKind, ProviderError} = this._ctx;
        const token = await this._readToken(cancellable);

        const response = await http.getJSON(this.usageUrl(), {"Authorization": `Bearer ${token}`}, cancellable);

        if (response.status === 401 || response.status === 403) {
            throw new ProviderError(ErrorKind.AUTH,
                _("Kimi rejected the sign-in. Send a message in Kimi Code to renew it."));
        }
        if (response.status === 429)
            throw new ProviderError(ErrorKind.RATE_LIMITED, _("Too many requests. Retrying later."));
        if (response.status < 200 || response.status >= 300)
            throw new ProviderError(ErrorKind.SERVER, _("Unexpected response from Kimi (HTTP %d).").format(response.status));

        const body = response.json;
        if (body && body.data && body.data.kind === "error")
            throw new ProviderError(ErrorKind.SERVER, _("Kimi returned no usage data."));

        const usage = parseUsage(body, _, util);
        if (usage.limits.length === 0)
            throw new ProviderError(ErrorKind.SERVER, _("Kimi returned no usage data."));
        return usage;
    }
}

module.exports = {KimiProvider, parseUsage};
