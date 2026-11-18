const Applet = imports.ui.applet;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;

const UUID = "ai-usage@dmcallejo";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(text) {
    return Gettext.dgettext(UUID, text);
}

const util = require("./lib/util");
const {ErrorKind, ProviderError} = require("./lib/errors");
const {HttpClient} = require("./lib/http");
const {readJSON, watchFile} = require("./lib/files");
const {AnthropicProvider} = require("./providers/anthropic");
const {CodexProvider} = require("./providers/codex");

// To add a provider: implement the interface described in providers/README.md,
// add its class here and an "<id>-mode" combobox to settings-schema.json.
const PROVIDER_CLASSES = [AnthropicProvider, CodexProvider];

const MODE_AUTO = "auto";
const MODE_ON = "on";
const MODE_OFF = "off";

const LABEL_TICK_SECONDS = 60;
const MIN_REFRESH_MINUTES = 1;
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
// Requests time out after 20 s; anything still pending after this is stuck.
const STUCK_REFRESH_MS = 2 * 60 * 1000;
// Credential files are often written in several steps; wait for them to settle.
const WATCH_DEBOUNCE_SECONDS = 2;
const BAR_WIDTH = 240;
const SEVERITY_CLASSES = ["ai-usage-warning", "ai-usage-critical"];

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

class AiUsageApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._metadata = metadata;
        this._refreshTimerId = 0;
        this._labelTimerId = 0;
        this._cancellable = null;
        this._refreshStartedAt = 0;
        this._monitors = [];
        this._watchDebounceId = 0;
        this._destroyed = false;
        this._lastUpdated = null;
        this._notified = new Set();
        this._states = [];

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("panel-display", "panelDisplay", () => this._render());
        this.settings.bind("show-reset-in-panel", "showResetInPanel", () => this._render());
        this.settings.bind("show-extra-usage", "showExtraUsage", () => this._render());
        this.settings.bind("warning-threshold", "warningThreshold", () => this._render());
        this.settings.bind("critical-threshold", "criticalThreshold", () => this._render());
        this.settings.bind("notify-critical", "notifyCritical");
        this.settings.bind("refresh-interval", "refreshInterval", () => this._startRefreshTimer());
        for (const ProviderClass of PROVIDER_CLASSES) {
            const id = ProviderClass.id;
            this.settings.bind(`${id}-mode`, `${id}Mode`, () => this._onProvidersChanged());
            // Providers read their own settings on demand; changes only need a new request.
            for (const key of ProviderClass.settingKeys || [])
                this.settings.bind(`${id}-${key}`, `_setting_${id}_${key}`, () => this._onProvidersChanged());
        }

        this._http = new HttpClient(`cinnamon-applet-${metadata.uuid}/${metadata.version || "dev"}`);

        this.set_applet_icon_symbolic_path(`${metadata.path}/icons/ai-usage-symbolic.svg`);
        this.set_applet_tooltip(_("AI usage limits"));

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", (menu, open) => {
            if (open)
                this._buildMenu();
        });

        this._applet_context_menu.addAction(_("Refresh now"), () => this._refresh());

        this._createProviders();
        this._render();
        this._startRefreshTimer();
        this._startLabelTimer();
        this._refresh();
    }

    // ----- Providers -----------------------------------------------------

    _createProviders() {
        const ctx = {
            _,
            util,
            ErrorKind,
            ProviderError,
            http: this._http,
            readJSON,
            homeDir: GLib.get_home_dir(),
            getenv: (name) => GLib.getenv(name),
        };
        this._states = PROVIDER_CLASSES
            .filter((ProviderClass) => this._providerMode(ProviderClass) !== MODE_OFF)
            .map((ProviderClass) => {
                const providerCtx = Object.assign({}, ctx, {
                    getSetting: (key) => this.settings.getValue(`${ProviderClass.id}-${key}`),
                });
                return {
                    provider: new ProviderClass(providerCtx),
                    data: null,
                    error: null,
                    backoffUntil: 0,
                    mode: this._providerMode(ProviderClass),
                    // Automatic providers stay hidden until a sign-in is found.
                    signedIn: true,
                };
            });
        this._watchProviderFiles();
    }

    _providerMode(ProviderClass) {
        const mode = this[`${ProviderClass.id}Mode`];
        return mode === MODE_ON || mode === MODE_OFF ? mode : MODE_AUTO;
    }

    // Providers shown in the panel and menu.
    _visibleStates() {
        return this._states.filter((state) => state.mode === MODE_ON || state.signedIn);
    }

    // ----- Credential file watching ---------------------------------------

    _watchProviderFiles() {
        this._stopWatching();
        for (const {provider} of this._states) {
            const paths = typeof provider.watchPaths === "function" ? provider.watchPaths() : [];
            for (const path of paths) {
                try {
                    this._monitors.push(watchFile(path, () => this._onWatchedFileChanged()));
                } catch (e) {
                    global.logWarning(`[${UUID}] Cannot watch ${path}: ${e.message}`);
                }
            }
        }
    }

    _stopWatching() {
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
        if (this._watchDebounceId) {
            GLib.source_remove(this._watchDebounceId);
            this._watchDebounceId = 0;
        }
    }

    _onWatchedFileChanged() {
        if (this._watchDebounceId)
            GLib.source_remove(this._watchDebounceId);
        this._watchDebounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WATCH_DEBOUNCE_SECONDS, () => {
            this._watchDebounceId = 0;
            // A request already running may be using the old credentials.
            this._cancelRequests();
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onProvidersChanged() {
        this._cancelRequests();
        this._createProviders();
        this._render();
        this._refresh();
    }

    // ----- Data refresh --------------------------------------------------

    _cancelRequests() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    async _refresh() {
        if (this._destroyed)
            return;
        if (this._cancellable) {
            // A refresh is running. Only replace it if it looks stuck.
            if (Date.now() - this._refreshStartedAt < STUCK_REFRESH_MS)
                return;
            this._cancelRequests();
        }
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._refreshStartedAt = Date.now();
        const states = this._states;

        await Promise.all(states.map((state) => this._refreshProvider(state, cancellable)));

        // The applet was removed, or the provider list was rebuilt, while waiting.
        if (cancellable.is_cancelled())
            return;
        this._cancellable = null;
        this._lastUpdated = new Date();
        this._notifyCriticalLimits();
        this._render();
        if (this.menu.isOpen)
            this._buildMenu();
    }

    async _refreshProvider(state, cancellable) {
        if (Date.now() < state.backoffUntil)
            return;
        try {
            state.data = await state.provider.fetch(cancellable);
            state.error = null;
            state.signedIn = true;
        } catch (e) {
            if (isCancelled(e) || cancellable.is_cancelled())
                return;
            if (e instanceof ProviderError && e.kind === ErrorKind.NOT_FOUND) {
                // Not signed in: hidden in automatic mode, an error otherwise.
                state.signedIn = false;
                state.data = null;
                state.error = state.mode === MODE_ON ? e.message : null;
            } else if (e instanceof ProviderError) {
                state.signedIn = true;
                state.error = e.message;
                if (e.kind === ErrorKind.RATE_LIMITED)
                    state.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
                // Stale numbers would be misleading after a sign-in problem.
                if (e.kind === ErrorKind.AUTH || e.kind === ErrorKind.CONFIG)
                    state.data = null;
            } else {
                global.logWarning(`[${UUID}] ${state.provider.name}: ${e.message}`);
                state.error = _("Could not reach %s. Check your connection.").format(state.provider.name);
            }
        }
    }

    _startRefreshTimer() {
        if (this._refreshTimerId)
            GLib.source_remove(this._refreshTimerId);
        const minutes = Math.max(MIN_REFRESH_MINUTES, Number(this.refreshInterval) || 5);
        this._refreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Keeps the reset countdown in the panel current between refreshes.
    _startLabelTimer() {
        this._labelTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LABEL_TICK_SECONDS, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ----- Helpers -------------------------------------------------------

    _severity(percent) {
        return util.severityFor(percent, this.warningThreshold, this.criticalThreshold);
    }

    _setSeverityClass(actor, severity) {
        for (const name of SEVERITY_CLASSES)
            actor.remove_style_class_name(name);
        if (severity !== util.SEVERITY_NORMAL)
            actor.add_style_class_name(`ai-usage-${severity}`);
    }

    // Limits shown in the panel, in provider order. Each entry keeps its provider.
    _panelEntries() {
        const entries = [];
        for (const state of this._visibleStates()) {
            if (!state.data)
                continue;
            const limits = state.data.limits;
            if (this.panelDisplay === "primary") {
                if (limits.length > 0)
                    entries.push({state, limit: limits[0]});
            } else {
                for (const limit of limits)
                    entries.push({state, limit});
            }
        }
        if (this.panelDisplay === "highest" && entries.length > 1) {
            const highest = entries.reduce((a, b) => (b.limit.percent > a.limit.percent ? b : a));
            return [highest];
        }
        return entries;
    }

    _resetText(limit) {
        if (!limit.resetsAt)
            return "";
        return util.formatDuration(limit.resetsAt.getTime() - Date.now(), _);
    }

    _resetDetail(limit) {
        if (!limit.resetsAt)
            return "";
        const when = GLib.DateTime.new_from_unix_local(Math.floor(limit.resetsAt.getTime() / 1000));
        const ms = limit.resetsAt.getTime() - Date.now();
        const format = ms < 24 * 3600 * 1000 ? "%H:%M" : "%a %H:%M";
        return _("Resets in %s (%s)").format(this._resetText(limit), when.format(format));
    }

    // ----- Panel ---------------------------------------------------------

    _render() {
        if (this._destroyed)
            return;
        this._renderLabel();
        this._renderTooltip();
    }

    _renderLabel() {
        const entries = this._panelEntries();
        const visible = this._visibleStates();
        const hasError = visible.some((state) => state.error);
        let text = "";
        let severity = util.SEVERITY_NORMAL;

        if (this.panelDisplay !== "icon") {
            if (entries.length === 0) {
                text = visible.length === 0 ? "" : (hasError ? "!" : "…");
            } else {
                const parts = entries.map(({limit}) => util.formatPercent(limit.percent));
                text = parts.join(" · ");
                if (this.showResetInPanel && entries.length === 1) {
                    const reset = this._resetText(entries[0].limit);
                    if (reset)
                        text = `${text} · ${reset}`;
                }
            }
        }
        for (const {limit} of entries) {
            const s = this._severity(limit.percent);
            if (s === util.SEVERITY_CRITICAL || (s === util.SEVERITY_WARNING && severity === util.SEVERITY_NORMAL))
                severity = s;
        }

        this.set_applet_label(text);
        this._setSeverityClass(this._applet_label, severity);
        // Dim the applet while showing data that failed to refresh.
        this.actor.opacity = hasError && entries.length > 0 ? 160 : 255;
    }

    _renderTooltip() {
        const lines = [];
        for (const state of this._visibleStates()) {
            const {provider, data, error} = state;
            const plan = data && data.plan ? ` (${data.plan})` : "";
            lines.push(`${provider.name}${plan}`);
            if (data) {
                for (const limit of data.limits) {
                    const reset = this._resetText(limit);
                    const value = util.formatPercent(limit.percent);
                    lines.push(reset
                        ? _("%s: %s, resets in %s").format(limit.label, value, reset)
                        : `${limit.label}: ${value}`);
                }
            }
            if (error)
                lines.push(error);
        }
        if (lines.length === 0)
            lines.push(this._noProviderText());
        this.set_applet_tooltip(lines.join("\n"));
    }

    _noProviderText() {
        if (this._states.length === 0)
            return _("All providers are turned off in the applet settings.");
        return _("No sign-in found. Sign in to Claude Code or the Codex CLI, then the applet picks it up automatically.");
    }

    // ----- Menu ----------------------------------------------------------

    _buildMenu() {
        this.menu.removeAll();

        const visible = this._visibleStates();
        if (visible.length === 0)
            this._addInfoItem(this._noProviderText());

        for (const state of visible) {
            const {provider, data, error} = state;
            const title = data && data.plan
                ? _("%s (%s plan)").format(provider.name, data.plan)
                : provider.name;
            const header = new PopupMenu.PopupMenuItem(title, {reactive: false});
            header.label.add_style_class_name("ai-usage-provider");
            this.menu.addMenuItem(header);

            if (data) {
                for (const limit of data.limits)
                    this._addLimitItem(limit.label, limit.percent, this._resetDetail(limit));
                if (data.spend && this.showExtraUsage) {
                    const spend = data.spend;
                    const detail = _("%s of %s").format(
                        util.formatMoney(spend.used, spend.currency),
                        util.formatMoney(spend.limit, spend.currency));
                    this._addLimitItem(spend.label, spend.percent, detail);
                }
            } else if (!error) {
                this._addInfoItem(_("Loading..."));
            }
            if (error)
                this._addInfoItem(error, "ai-usage-error");

            if (provider.dashboardUrl) {
                this.menu.addAction(_("Open %s usage page").format(provider.name), () => {
                    Gio.AppInfo.launch_default_for_uri_async(provider.dashboardUrl, null, null, null);
                });
            }
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        if (this._lastUpdated) {
            const time = GLib.DateTime.new_from_unix_local(Math.floor(this._lastUpdated.getTime() / 1000));
            this._addInfoItem(_("Updated at %s").format(time.format("%H:%M")), "ai-usage-dim");
        }
        this.menu.addAction(_("Refresh now"), () => this._refresh());
    }

    _addInfoItem(text, styleClass) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.clutter_text.line_wrap = true;
        item.label.add_style_class_name("ai-usage-info");
        if (styleClass)
            item.label.add_style_class_name(styleClass);
        this.menu.addMenuItem(item);
    }

    _addLimitItem(label, percent, detail) {
        const severity = this._severity(percent);
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const box = new St.BoxLayout({vertical: true, style_class: "ai-usage-limit", x_expand: true});

        const row = new St.BoxLayout({x_expand: true});
        row.add_child(new St.Label({text: label, x_expand: true, style_class: "ai-usage-limit-name"}));
        const value = new St.Label({text: util.formatPercent(percent), style_class: "ai-usage-limit-value"});
        this._setSeverityClass(value, severity);
        row.add_child(value);
        box.add_child(row);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = BAR_WIDTH * scale;
        const trough = new St.BoxLayout({style_class: "ai-usage-bar"});
        trough.set_width(width);
        const fill = new St.Widget({style_class: "ai-usage-bar-fill"});
        fill.set_width(Math.round((width * percent) / 100));
        this._setSeverityClass(fill, severity);
        trough.add_child(fill);
        box.add_child(trough);

        if (detail)
            box.add_child(new St.Label({text: detail, style_class: "ai-usage-limit-detail"}));

        item.addActor(box, {expand: true});
        this.menu.addMenuItem(item);
    }

    // ----- Notifications -------------------------------------------------

    _notifyCriticalLimits() {
        const current = new Set();
        for (const {provider, data} of this._visibleStates()) {
            if (!data)
                continue;
            for (const limit of data.limits) {
                if (this._severity(limit.percent) !== util.SEVERITY_CRITICAL)
                    continue;
                const key = `${provider.id}:${limit.id}`;
                current.add(key);
                if (!this.notifyCritical || this._notified.has(key))
                    continue;
                const reset = this._resetText(limit);
                Main.notify(
                    _("%s: %s at %s").format(provider.name, limit.label, util.formatPercent(limit.percent)),
                    reset ? _("Resets in %s.").format(reset) : "");
            }
        }
        // Forget limits that dropped below the threshold so they notify again next time.
        this._notified = current;
    }

    // ----- Applet hooks --------------------------------------------------

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_middle_clicked() {
        this._refresh();
    }

    on_applet_removed_from_panel() {
        this._destroyed = true;
        if (this._refreshTimerId) {
            GLib.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        if (this._labelTimerId) {
            GLib.source_remove(this._labelTimerId);
            this._labelTimerId = 0;
        }
        this._stopWatching();
        this._cancelRequests();
        this._http.destroy();
        this.settings.finalize();
        this.menu.destroy();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new AiUsageApplet(metadata, orientation, panelHeight, instanceId);
}
