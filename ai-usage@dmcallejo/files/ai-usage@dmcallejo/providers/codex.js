// Codex (OpenAI) usage limits of a ChatGPT plan.
//
// Reads the sign-in that the Codex CLI stores after `codex login` and asks the
// same endpoint Codex uses for its `/status` view. These are the Codex limits
// of the ChatGPT plan, not the message limits of the ChatGPT chat apps, which
// OpenAI does not expose.
//
// The endpoint is not part of OpenAI's public API, so the parser is tolerant:
// unknown fields are ignored. The response also contains the account e-mail
// and IDs; they are never read, shown or logged.
//
// The token is only read, never refreshed or written: refreshing would rotate
// the Codex CLI's refresh token behind its back.
//
// Providers receive every dependency through `ctx` (see CONTRIBUTING.md).

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DASHBOARD_URL = "https://chatgpt.com/codex/settings/usage";

const FIVE_HOURS = 5 * 3600;
const ONE_WEEK = 7 * 24 * 3600;

function windowLabel(seconds, _, util) {
    // Allow some slack in case the server reports a slightly different length.
    if (Math.abs(seconds - FIVE_HOURS) <= 600)
        return _("5-hour limit");
    if (Math.abs(seconds - ONE_WEEK) <= 3600)
        return _("Weekly limit");
    if (seconds > 0)
        return _("%s limit").format(util.formatDuration(seconds * 1000, _));
    return _("Usage limit");
}

function resetDate(window, now, util) {
    const resetAt = Number(window.reset_at);
    if (Number.isFinite(resetAt) && resetAt > 0)
        return new Date(resetAt * 1000);
    const after = Number(window.reset_after_seconds);
    if (Number.isFinite(after) && after >= 0)
        return new Date(now + after * 1000);
    return util.parseDate(window.resets_at);
}

// Parses a {primary_window, secondary_window} object into limits.
function parseRateLimit(rateLimit, idPrefix, labelPrefix, now, _, util) {
    const limits = [];
    if (!rateLimit || typeof rateLimit !== "object")
        return limits;
    for (const key of ["primary_window", "secondary_window"]) {
        const window = rateLimit[key];
        if (!window || typeof window !== "object")
            continue;
        const percent = util.clampPercent(window.used_percent);
        if (percent === null)
            continue;
        const label = windowLabel(Number(window.limit_window_seconds), _, util);
        limits.push({
            id: `${idPrefix}:${key}`,
            label: labelPrefix ? _("%s, %s").format(labelPrefix, label) : label,
            percent,
            resetsAt: resetDate(window, now, util),
        });
    }
    return limits;
}

function parseUsage(body, _, util, now = Date.now()) {
    if (!body || typeof body !== "object")
        return {plan: null, limits: [], blocked: false};

    const limits = parseRateLimit(body.rate_limit, "codex", null, now, _, util);
    limits.push(...parseRateLimit(body.code_review_rate_limit, "code-review", _("Code review"), now, _, util));

    if (Array.isArray(body.additional_rate_limits)) {
        for (const extra of body.additional_rate_limits) {
            if (!extra || typeof extra !== "object")
                continue;
            const name = extra.limit_name || extra.metered_feature;
            if (!name)
                continue;
            limits.push(...parseRateLimit(extra.rate_limit, `extra:${name}`, util.humanize(name), now, _, util));
        }
    }

    const plan = typeof body.plan_type === "string" && body.plan_type ? body.plan_type : null;
    const rateLimit = body.rate_limit && typeof body.rate_limit === "object" ? body.rate_limit : {};
    const blocked = rateLimit.limit_reached === true || rateLimit.allowed === false;
    return {plan, limits, blocked};
}

class CodexProvider {
    constructor(ctx) {
        this._ctx = ctx;
    }

    static get id() {
        return "codex";
    }

    // Read through ctx.getSetting(); stored as "codex-<key>" in settings-schema.json.
    static get settingKeys() {
        return ["auth-path"];
    }

    get id() {
        return CodexProvider.id;
    }

    get name() {
        return "Codex";
    }

    // Generic symbol in icons/; users can pick another one in the settings.
    get iconFile() {
        return "provider-codex-symbolic.svg";
    }

    get dashboardUrl() {
        return DASHBOARD_URL;
    }

    authPath() {
        const {getSetting, getenv, homeDir, util} = this._ctx;
        const custom = (getSetting("auth-path") || "").trim();
        if (custom)
            return util.expandHome(custom, homeDir);
        const codexHome = getenv("CODEX_HOME");
        if (codexHome)
            return `${util.expandHome(codexHome, homeDir)}/auth.json`;
        return `${homeDir}/.codex/auth.json`;
    }

    // The Codex CLI rewrites this file when it renews the sign-in.
    watchPaths() {
        return [this.authPath()];
    }

    async _readToken(cancellable) {
        const {_, readJSON, ErrorKind, ProviderError} = this._ctx;
        const path = this.authPath();

        let auth;
        try {
            auth = await readJSON(path, cancellable);
        } catch (e) {
            if (e.code === "ENOENT") {
                throw new ProviderError(ErrorKind.NOT_FOUND,
                    _("No Codex sign-in found at %s. Sign in with the Codex CLI first.").format(path));
            }
            if (e.code === "EINVAL")
                throw new ProviderError(ErrorKind.CONFIG, _("Could not parse %s.").format(path));
            throw e;
        }

        const tokens = auth && auth.tokens;
        if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) {
            throw new ProviderError(ErrorKind.CONFIG,
                _("No ChatGPT sign-in found in %s. API keys do not have plan limits.").format(path));
        }
        return {
            token: tokens.access_token,
            accountId: typeof tokens.account_id === "string" ? tokens.account_id : null,
        };
    }

    async fetch(cancellable) {
        const {_, http, util, ErrorKind, ProviderError} = this._ctx;
        const {token, accountId} = await this._readToken(cancellable);

        const headers = {"Authorization": `Bearer ${token}`};
        if (accountId)
            headers["ChatGPT-Account-Id"] = accountId;
        const response = await http.getJSON(USAGE_URL, headers, cancellable);

        if (response.status === 401 || response.status === 403) {
            throw new ProviderError(ErrorKind.AUTH,
                _("ChatGPT rejected the Codex sign-in. Run Codex to renew it."));
        }
        if (response.status === 429)
            throw new ProviderError(ErrorKind.RATE_LIMITED, _("Too many requests. Retrying later."));
        if (response.status < 200 || response.status >= 300)
            throw new ProviderError(ErrorKind.SERVER, _("Unexpected response from Codex (HTTP %d).").format(response.status));

        const usage = parseUsage(response.json, _, util);
        if (usage.limits.length === 0)
            throw new ProviderError(ErrorKind.SERVER, _("Codex returned no usage data."));

        return {
            plan: usage.plan ? util.capitalize(usage.plan) : null,
            limits: usage.limits,
            spend: null,
            blocked: usage.blocked,
        };
    }
}

module.exports = {CodexProvider, parseUsage};
