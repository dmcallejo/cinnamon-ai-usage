// Claude (Anthropic) subscription usage.
//
// Reads the OAuth token that Claude Code stores after `claude /login` and asks
// the same usage endpoint Claude Code uses for its `/usage` view. The endpoint
// is not part of Anthropic's public API, so the parser is deliberately
// tolerant: unknown fields are ignored and both the current `limits` array and
// the older per-window objects are understood.
//
// The token is only read, never refreshed or written: refreshing would rotate
// Claude Code's refresh token behind its back.
//
// Providers receive every dependency through `ctx` (see providers/README.md),
// which keeps this file free of `imports.*` and testable under Node.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DASHBOARD_URL = "https://claude.ai/settings/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

// Older responses expose one object per window instead of the `limits` array.
const LEGACY_WINDOWS = [
    ["five_hour", "session"],
    ["seven_day", "weekly_all"],
    ["seven_day_opus", "weekly_opus"],
    ["seven_day_sonnet", "weekly_sonnet"],
];

function limitLabel(kind, _, util) {
    switch (kind) {
    case "session":
        return _("Current session");
    case "weekly_all":
        return _("Weekly, all models");
    case "weekly_opus":
        return _("Weekly, Opus");
    case "weekly_sonnet":
        return _("Weekly, Sonnet");
    default:
        return util.humanize(kind);
    }
}

function parseLimits(body, _, util) {
    const limits = [];

    if (Array.isArray(body.limits)) {
        for (const item of body.limits) {
            if (!item || typeof item.kind !== "string")
                continue;
            const percent = util.clampPercent(item.percent);
            if (percent === null)
                continue;
            let label = limitLabel(item.kind, _, util);
            if (typeof item.scope === "string" && item.scope)
                label = `${label} (${item.scope})`;
            limits.push({
                id: item.scope ? `${item.kind}:${item.scope}` : item.kind,
                label,
                percent,
                resetsAt: util.parseDate(item.resets_at),
            });
        }
        if (limits.length > 0)
            return limits;
    }

    for (const [key, kind] of LEGACY_WINDOWS) {
        const window = body[key];
        if (!window || typeof window !== "object")
            continue;
        const percent = util.clampPercent(window.utilization);
        if (percent === null)
            continue;
        limits.push({
            id: kind,
            label: limitLabel(kind, _, util),
            percent,
            resetsAt: util.parseDate(window.resets_at),
        });
    }
    return limits;
}

// Pay-as-you-go credits used once the plan limits are exhausted.
function parseSpend(body, _, util) {
    const spend = body.spend;
    if (spend && spend.enabled && spend.used && spend.limit) {
        const exponent = Number(spend.used.exponent) || 0;
        const used = Number(spend.used.amount_minor) / 10 ** exponent;
        const limit = Number(spend.limit.amount_minor) / 10 ** exponent;
        if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
            return {
                label: _("Extra usage"),
                used,
                limit,
                currency: spend.used.currency || spend.limit.currency || "",
                percent: util.clampPercent((used / limit) * 100),
            };
        }
    }

    const extra = body.extra_usage;
    if (extra && extra.is_enabled && Number(extra.monthly_limit) > 0) {
        const divisor = 10 ** (Number(extra.decimal_places) || 0);
        const used = Number(extra.used_credits) / divisor;
        const limit = Number(extra.monthly_limit) / divisor;
        if (Number.isFinite(used)) {
            return {
                label: _("Extra usage"),
                used,
                limit,
                currency: extra.currency || "",
                percent: util.clampPercent((used / limit) * 100),
            };
        }
    }
    return null;
}

function parseUsage(body, _, util) {
    if (!body || typeof body !== "object")
        return {limits: [], spend: null};
    return {
        limits: parseLimits(body, _, util),
        spend: parseSpend(body, _, util),
    };
}

class AnthropicProvider {
    constructor(ctx) {
        this._ctx = ctx;
    }

    static get id() {
        return "anthropic";
    }

    // Read through ctx.getSetting(); stored as "anthropic-<key>" in settings-schema.json.
    // Environment variable the CLI uses for its config folder. Extra accounts
    // set it to their own folder.
    static get homeEnv() {
        return "CLAUDE_CONFIG_DIR";
    }

    static get settingKeys() {
        return ["credentials-path"];
    }

    get id() {
        return AnthropicProvider.id;
    }

    get name() {
        return "Claude";
    }

    // Generic symbol in icons/; users can pick another one in the settings.
    get iconFile() {
        return "provider-claude-symbolic.svg";
    }

    get dashboardUrl() {
        return DASHBOARD_URL;
    }

    credentialsPath() {
        const {getSetting, getenv, homeDir, util} = this._ctx;
        const custom = (getSetting("credentials-path") || "").trim();
        if (custom)
            return util.expandHome(custom, homeDir);
        const configDir = getenv("CLAUDE_CONFIG_DIR");
        if (configDir)
            return `${util.expandHome(configDir, homeDir)}/.credentials.json`;
        return `${homeDir}/.claude/.credentials.json`;
    }

    // Claude Code rewrites this file when it renews the sign-in; the applet
    // refreshes as soon as that happens instead of waiting for the next tick.
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
                    _("No Claude Code sign-in found at %s. Sign in with Claude Code first.").format(path));
            }
            if (e.code === "EINVAL")
                throw new ProviderError(ErrorKind.CONFIG, _("Could not parse %s.").format(path));
            throw e;
        }

        const oauth = credentials && credentials.claudeAiOauth;
        if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) {
            throw new ProviderError(ErrorKind.CONFIG,
                _("No Claude subscription sign-in found in %s. API keys do not have plan limits.").format(path));
        }
        if (Number(oauth.expiresAt) > 0 && Number(oauth.expiresAt) <= Date.now()) {
            throw new ProviderError(ErrorKind.AUTH,
                _("The Claude Code sign-in has expired. Send a message in Claude Code to renew it."));
        }
        return {token: oauth.accessToken, plan: oauth.subscriptionType || null};
    }

    async fetch(cancellable) {
        const {_, http, util, ErrorKind, ProviderError} = this._ctx;
        const {token, plan} = await this._readToken(cancellable);

        const response = await http.getJSON(USAGE_URL, {
            "Authorization": `Bearer ${token}`,
            "anthropic-beta": OAUTH_BETA_HEADER,
        }, cancellable);

        if (response.status === 401 || response.status === 403) {
            throw new ProviderError(ErrorKind.AUTH,
                _("Claude rejected the sign-in. Send a message in Claude Code to renew it."));
        }
        if (response.status === 429)
            throw new ProviderError(ErrorKind.RATE_LIMITED, _("Too many requests. Retrying later."));
        if (response.status < 200 || response.status >= 300)
            throw new ProviderError(ErrorKind.SERVER, _("Unexpected response from Claude (HTTP %d).").format(response.status));

        const usage = parseUsage(response.json, _, util);
        if (usage.limits.length === 0 && !usage.spend)
            throw new ProviderError(ErrorKind.SERVER, _("Claude returned no usage data."));

        return {
            plan: plan ? util.capitalize(plan) : null,
            limits: usage.limits,
            spend: usage.spend,
        };
    }
}

module.exports = {AnthropicProvider, parseUsage};
