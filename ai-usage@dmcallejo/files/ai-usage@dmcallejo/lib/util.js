// Pure helpers shared by the applet and the providers.
// This file must not use `imports.*` so it can be unit tested under Node.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SEVERITY_NORMAL = "normal";
const SEVERITY_WARNING = "warning";
const SEVERITY_CRITICAL = "critical";

function clampPercent(value) {
    if (value === null || value === undefined || value === "")
        return null;
    const n = Number(value);
    if (!Number.isFinite(n))
        return null;
    return Math.min(100, Math.max(0, n));
}

function severityFor(percent, warningThreshold, criticalThreshold) {
    if (percent === null || percent === undefined)
        return SEVERITY_NORMAL;
    // A misconfigured pair (warning above critical) degrades gracefully.
    const critical = Math.max(warningThreshold, criticalThreshold);
    const warning = Math.min(warningThreshold, criticalThreshold);
    if (percent >= critical)
        return SEVERITY_CRITICAL;
    if (percent >= warning)
        return SEVERITY_WARNING;
    return SEVERITY_NORMAL;
}

// Compact, translatable duration: "45m", "2h 05m", "3d 4h".
// `_` is the gettext function of the caller.
function formatDuration(ms, _) {
    if (!Number.isFinite(ms) || ms <= 0)
        return _("now");
    if (ms < MINUTE)
        return _("<1m");
    if (ms < HOUR)
        return _("%dm").format(Math.floor(ms / MINUTE));
    if (ms < DAY) {
        const h = Math.floor(ms / HOUR);
        const m = Math.floor((ms % HOUR) / MINUTE);
        return _("%dh %sm").format(h, String(m).padStart(2, "0"));
    }
    const d = Math.floor(ms / DAY);
    const h = Math.floor((ms % DAY) / HOUR);
    return _("%dd %dh").format(d, h);
}

function formatPercent(percent) {
    return `${Math.round(percent)}%`;
}

function formatMoney(amount, currency) {
    try {
        return new Intl.NumberFormat(undefined, {style: "currency", currency}).format(amount);
    } catch (e) {
        return `${amount.toFixed(2)} ${currency || ""}`.trim();
    }
}

function parseDate(value) {
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// "weekly_oauth_apps" -> "Weekly oauth apps"
function humanize(identifier) {
    const text = String(identifier).replace(/[_-]+/g, " ").trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function capitalize(text) {
    if (!text)
        return "";
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function expandHome(path, homeDir) {
    if (path === "~")
        return homeDir;
    if (path.startsWith("~/"))
        return homeDir + path.slice(1);
    return path;
}

module.exports = {
    SEVERITY_NORMAL,
    SEVERITY_WARNING,
    SEVERITY_CRITICAL,
    clampPercent,
    severityFor,
    formatDuration,
    formatPercent,
    formatMoney,
    parseDate,
    humanize,
    capitalize,
    expandHome,
};
