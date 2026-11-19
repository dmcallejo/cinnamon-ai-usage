// Turns the rows of an "<id>-accounts" list setting into extra accounts.
// This file must not use `imports.*` nor load other modules (see
// CONTRIBUTING.md); helpers come in `options`.

// rows:    [{name, folder, icon, enabled}] as stored by Cinnamon's list widget.
// options: {homeDir, expandHome(path, homeDir), defaultName(index)}
// Returns: [{key, name, folder, icon}] for enabled rows. `folder` is "" when
//          missing; the caller reports it. Keys are unique per provider.
function parseAccounts(providerId, rows, options) {
    const accounts = [];
    const used = new Set();
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
        if (!row || typeof row !== "object" || row.enabled === false)
            return;
        let folder = String(row.folder || "").trim().replace(/^file:\/\//, "");
        if (folder)
            folder = options.expandHome(decodeURIComponent(folder), options.homeDir).replace(/\/+$/, "");
        const name = String(row.name || "").trim() ||
            (folder ? folder.split("/").pop() : options.defaultName(index));
        let key = `${providerId}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || index}`;
        while (used.has(key))
            key += "-";
        used.add(key);
        accounts.push({key, name, folder, icon: String(row.icon || "").trim()});
    });
    return accounts;
}

module.exports = {parseAccounts};
