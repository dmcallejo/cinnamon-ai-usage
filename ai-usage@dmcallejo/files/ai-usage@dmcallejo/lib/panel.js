// Decides what the panel shows: one segment (icon + text) per provider.
// This file must not use `imports.*` so it can be unit tested under Node.
// It does not load other modules either: Cinnamon resolves module paths from
// the applet directory, not from this file, so helpers come in `options`.

const SEVERITY_NORMAL = "normal";
const SEVERITY_WARNING = "warning";
const SEVERITY_CRITICAL = "critical";

const SEPARATOR = " · ";

const SEVERITY_RANK = {
    [SEVERITY_NORMAL]: 0,
    [SEVERITY_WARNING]: 1,
    [SEVERITY_CRITICAL]: 2,
};

function worstSeverity(severities) {
    return severities.reduce(
        (worst, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst),
        SEVERITY_NORMAL);
}

// providers: [{id, limits: [{percent, resetsAt}]}], in display order, only
//            those with data.
// mode:      "highest" | "primary" | "all" | "icon"
// options:   {showReset, compact, severity(percent), resetText(limit),
//             formatPercent(percent)}
//            `compact` (vertical panels) keeps only one percentage per icon.
// Returns:   [{providerId, text, severity}]
function panelSegments(providers, mode, options) {
    let entries = [];
    for (const provider of providers) {
        const limits = mode === "primary" ? provider.limits.slice(0, 1) : provider.limits;
        for (const limit of limits)
            entries.push({providerId: provider.id, limit});
    }
    if (mode === "highest" && entries.length > 1)
        entries = [entries.reduce((a, b) => (b.limit.percent > a.limit.percent ? b : a))];

    // Group consecutive entries of the same provider behind a single icon.
    const groups = [];
    for (const entry of entries) {
        const last = groups[groups.length - 1];
        if (last && last.providerId === entry.providerId)
            last.limits.push(entry.limit);
        else
            groups.push({providerId: entry.providerId, limits: [entry.limit]});
    }

    return groups.map(({providerId, limits}) => {
        const severity = worstSeverity(limits.map((l) => options.severity(l.percent)));
        let text = "";
        if (mode !== "icon") {
            if (options.compact) {
                const highest = limits.reduce((a, b) => (b.percent > a.percent ? b : a));
                text = options.formatPercent(highest.percent);
            } else {
                text = limits.map((l) => options.formatPercent(l.percent)).join(SEPARATOR);
                if (options.showReset && entries.length === 1) {
                    const reset = options.resetText(limits[0]);
                    if (reset)
                        text += SEPARATOR + reset;
                }
            }
        }
        return {providerId, text, severity};
    });
}

// True when any limit present in both snapshots went up. Drops (resets) and
// the first snapshot do not count as activity.
function usageIncreased(previous, current) {
    if (!previous || !current)
        return false;
    const before = new Map(previous.limits.map((limit) => [limit.id, limit.percent]));
    return current.limits.some((limit) => before.has(limit.id) && limit.percent > before.get(limit.id));
}

module.exports = {panelSegments, worstSeverity, usageIncreased};
