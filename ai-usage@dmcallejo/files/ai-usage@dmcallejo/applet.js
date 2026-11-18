const Applet = imports.ui.applet;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

const UUID = "ai-usage@dmcallejo";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(text) {
    return Gettext.dgettext(UUID, text);
}

const util = require("./lib/util");
const {ErrorKind, ProviderError} = require("./lib/errors");
const {HttpClient} = require("./lib/http");
const {readJSON, readText, watchFile} = require("./lib/files");
const {panelSegments, usageIncreased} = require("./lib/panel");
const {AnthropicProvider} = require("./providers/anthropic");
const {CodexProvider} = require("./providers/codex");
const {KimiProvider} = require("./providers/kimi");

// To add a provider: implement the interface described in providers/README.md,
// add its class here and an "<id>-mode" combobox to settings-schema.json.
const PROVIDER_CLASSES = [AnthropicProvider, CodexProvider, KimiProvider];

const MODE_AUTO = "auto";
const MODE_ON = "on";
const MODE_OFF = "off";
// "Panel shows" value that follows the provider whose usage rose last.
const PANEL_LATEST = "latest";

const LABEL_TICK_SECONDS = 60;
const STALE_OPACITY = 140;
const MIN_REFRESH_MINUTES = 1;
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
// Requests time out after 20 s; anything still pending after this is stuck.
const STUCK_REFRESH_MS = 2 * 60 * 1000;
// Credential files are often written in several steps; wait for them to settle.
const WATCH_DEBOUNCE_SECONDS = 2;
const SEVERITY_CLASSES = ["ai-usage-warning", "ai-usage-critical"];

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

class AiUsageApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._metadata = metadata;
        this._refreshTimerId = 0;
        this._labelTimerId = 0;
        this._cancellable = null;
        this._refreshStartedAt = 0;
        this._monitors = [];
        this._watchDebounceId = 0;
        // Custom icon path -> whether the file exists; checked asynchronously.
        this._iconFileExists = new Map();
        this._destroyed = false;
        this._lastUpdated = null;
        this._notified = new Set();
        this._states = [];

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("panel-display", "panelDisplay", () => this._render());
        this.settings.bind("show-reset-in-panel", "showResetInPanel", () => this._render());
        this.settings.bind("show-extra-usage", "showExtraUsage", () => this._render());
        // Provider id pinned to the panel from the menu; "" means automatic.
        this.settings.bind("panel-provider", "panelProvider", () => this._render());
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
            // Optional custom panel icon; empty means the built-in symbol.
            this.settings.bind(`${id}-icon`, `_setting_${id}_icon`, () => {
                this._iconFileExists.clear();
                this._render();
            });
        }

        this._http = new HttpClient(`cinnamon-applet-${metadata.uuid}/${metadata.version || "dev"}`);

        this._panelBox = new St.BoxLayout({style_class: "ai-usage-panel", y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._panelBox);
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
            readText,
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
            const previous = state.data;
            state.data = await state.provider.fetch(cancellable);
            state.updatedAt = new Date();
            if (usageIncreased(previous, state.data))
                state.changedAt = state.updatedAt;
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
                // Unusable credentials: the old numbers may belong to another
                // account. An expired sign-in keeps them, shown as stale.
                if (e.kind === ErrorKind.CONFIG)
                    state.data = null;
            } else {
                global.logWarning(`[${UUID}] ${state.provider.name}: ${e.message}`);
                state.error = _("Could not reach %s. Check your connection.").format(state.provider.name);
            }
        }
    }

    // Limits to display for a provider. Data that failed to refresh is kept
    // (and shown as stale), except windows that have reset since: their old
    // percentage is known to be wrong.
    _displayLimits(state) {
        if (!state.data)
            return [];
        if (!state.error)
            return state.data.limits;
        const now = Date.now();
        return state.data.limits.filter((limit) => !limit.resetsAt || limit.resetsAt.getTime() > now);
    }

    // The provider pinned to the panel, if it is currently shown at all.
    // A pinned provider that is signed out or turned off falls back to
    // automatic, and so does "most recent activity" until some usage rises.
    _pinnedState() {
        if (!this.panelProvider)
            return null;
        const visible = this._visibleStates();
        if (this.panelProvider === PANEL_LATEST) {
            const active = visible.filter((state) => state.changedAt && !state.error &&
                this._displayLimits(state).length > 0);
            if (active.length === 0)
                return null;
            return active.reduce((a, b) => (b.changedAt > a.changedAt ? b : a));
        }
        return visible.find((state) => state.provider.id === this.panelProvider) || null;
    }

    // Providers the panel shows. A pinned provider is always shown (dimmed if
    // stale). Otherwise stale data (expired sign-in, offline) is left out
    // unless nothing is up to date. "Highest usage" picks a single limit, so
    // it also skips providers whose limit is used up when another one can
    // still be used; the list modes show every up-to-date provider.
    _panelStates() {
        const pinned = this._pinnedState();
        if (pinned)
            return [pinned];
        const withData = this._visibleStates().filter((state) => this._displayLimits(state).length > 0);
        const fresh = withData.filter((state) => !this._isStale(state));
        if (fresh.length === 0)
            return withData;
        if (this.panelDisplay === "highest") {
            const usable = fresh.filter((state) => !this._isExhausted(state));
            if (usable.length > 0)
                return usable;
        }
        return fresh;
    }

    // A provider is exhausted when it says so, or when any limit is used up.
    _isExhausted(state) {
        if (!state.data)
            return false;
        return state.data.blocked === true ||
            this._displayLimits(state).some((limit) => limit.percent >= 100);
    }

    _isStale(state) {
        return Boolean(state.data && state.error);
    }

    _timeText(date) {
        return GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000)).format("%H:%M");
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
        this._renderPanel();
        this._renderTooltip();
    }

    _isVertical() {
        return this._orientation === St.Side.LEFT || this._orientation === St.Side.RIGHT;
    }

    // Built-in symbolic icons follow the panel theme; custom icons (an icon
    // name or an image path chosen in the settings) keep their own colors.
    _makeIcon(customValue, builtinFile, severity) {
        const value = (customValue || "").trim();
        let gicon;
        let symbolic;
        const path = value.includes("/") ? util.expandHome(value, GLib.get_home_dir()) : null;
        if (path && this._customIconUsable(path)) {
            gicon = new Gio.FileIcon({file: Gio.File.new_for_path(path)});
            symbolic = path.includes("-symbolic");
        } else if (value && !path) {
            gicon = new Gio.ThemedIcon({name: value});
            symbolic = value.endsWith("-symbolic");
        } else {
            gicon = new Gio.FileIcon({file: Gio.File.new_for_path(`${this._metadata.path}/icons/${builtinFile}`)});
            symbolic = true;
        }
        const iconType = symbolic ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
        const icon = new St.Icon({
            gicon,
            icon_type: iconType,
            style_class: symbolic ? "system-status-icon" : "applet-icon",
            y_align: Clutter.ActorAlign.CENTER,
        });
        const size = this.getPanelIconSize(iconType);
        if (size)
            icon.set_icon_size(size);
        if (symbolic)
            this._setSeverityClass(icon, severity);
        return icon;
    }

    // Unknown paths are checked in the background and the panel re-rendered;
    // until then, and when the file is missing, the built-in symbol is used.
    _customIconUsable(path) {
        if (this._iconFileExists.has(path))
            return this._iconFileExists.get(path);
        this._iconFileExists.set(path, false);
        Gio.File.new_for_path(path).query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (file, result) => {
                let exists = false;
                try {
                    exists = file.query_info_finish(result).get_file_type() === Gio.FileType.REGULAR;
                } catch (e) {
                    exists = false;
                }
                if (this._destroyed || !exists)
                    return;
                this._iconFileExists.set(path, true);
                this._render();
            });
        return false;
    }

    _addPanelSegment(icon, text, severity) {
        const segment = new St.BoxLayout({style_class: "ai-usage-segment", vertical: this._isVertical()});
        segment.add_child(icon);
        if (text) {
            const label = new St.Label({text, style_class: "applet-label", y_align: Clutter.ActorAlign.CENTER});
            this._setSeverityClass(label, severity);
            segment.add_child(label);
        }
        this._panelBox.add_child(segment);
        return segment;
    }

    _renderPanel() {
        const visible = this._visibleStates();
        const hasError = visible.some((state) => state.error);
        const byId = new Map(visible.map((state) => [state.provider.id, state]));
        const providers = this._panelStates()
            .map((state) => ({id: state.provider.id, limits: this._displayLimits(state)}))
            .filter((provider) => provider.limits.length > 0);
        const segments = panelSegments(providers, this.panelDisplay, {
            showReset: this.showResetInPanel,
            compact: this._isVertical(),
            severity: (percent) => this._severity(percent),
            resetText: (limit) => this._resetText(limit),
            formatPercent: util.formatPercent,
        });

        this._panelBox.destroy_all_children();
        this._panelBox.set_vertical(this._isVertical());

        if (segments.length === 0) {
            // Nothing to show yet: the applet's own icon plus a status mark.
            let text = "";
            if (visible.length > 0 && this.panelDisplay !== "icon")
                text = hasError ? "!" : "\u2026";
            this._addPanelSegment(this._makeIcon("", "ai-usage-symbolic.svg", util.SEVERITY_NORMAL), text, util.SEVERITY_NORMAL);
        }
        for (const segment of segments) {
            const state = byId.get(segment.providerId);
            const custom = this[`_setting_${state.provider.id}_icon`];
            const actor = this._addPanelSegment(
                this._makeIcon(custom, state.provider.iconFile, segment.severity), segment.text, segment.severity);
            // Dim numbers that failed to refresh.
            actor.opacity = this._isStale(state) ? STALE_OPACITY : 255;
        }
    }

    _renderTooltip() {
        const lines = [];
        for (const state of this._visibleStates()) {
            const {provider, data, error} = state;
            const plan = data && data.plan ? ` (${data.plan})` : "";
            lines.push(`${provider.name}${plan}`);
            if (data) {
                for (const limit of this._displayLimits(state)) {
                    const reset = this._resetText(limit);
                    const value = util.formatPercent(limit.percent);
                    lines.push(reset
                        ? _("%s: %s, resets in %s").format(limit.label, value, reset)
                        : `${limit.label}: ${value}`);
                }
            }
            if (error)
                lines.push(error);
            if (this._isStale(state) && state.updatedAt)
                lines.push(_("Last updated at %s.").format(this._timeText(state.updatedAt)));
        }
        if (lines.length === 0)
            lines.push(this._noProviderText());
        this.set_applet_tooltip(lines.join("\n"));
    }

    _noProviderText() {
        if (this._states.length === 0)
            return _("All providers are turned off in the applet settings.");
        return _("No sign-in found. Sign in to Claude Code, the Codex CLI or Kimi Code, then the applet picks it up automatically.");
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
                for (const limit of this._displayLimits(state))
                    this._addLimitItem(limit.label, limit.percent, this._resetDetail(limit), this._isStale(state));
                if (data.spend && this.showExtraUsage) {
                    const spend = data.spend;
                    const detail = _("%s of %s").format(
                        util.formatMoney(spend.used, spend.currency),
                        util.formatMoney(spend.limit, spend.currency));
                    this._addLimitItem(spend.label, spend.percent, detail, this._isStale(state));
                }
            } else if (!error) {
                this._addInfoItem(_("Loading..."));
            }
            if (error)
                this._addInfoItem(error, "ai-usage-error");
            if (this._isStale(state) && state.updatedAt)
                this._addInfoItem(_("Last updated at %s.").format(this._timeText(state.updatedAt)), "ai-usage-dim");

            if (provider.dashboardUrl) {
                this.menu.addAction(_("Open %s usage page").format(provider.name), () => {
                    Gio.AppInfo.launch_default_for_uri_async(provider.dashboardUrl, null, null, null);
                });
            }
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        if (visible.length > 1)
            this._addPanelProviderSelector(visible);

        if (this._lastUpdated) {
            this._addInfoItem(_("Updated at %s").format(this._timeText(this._lastUpdated)), "ai-usage-dim");
        }
        this.menu.addAction(_("Refresh now"), () => this._refresh());
    }

    // Quick choice of which provider the panel shows.
    _addPanelProviderSelector(visible) {
        const pinned = this._pinnedState();
        const choices = [
            {id: "", label: _("Automatic")},
            {id: PANEL_LATEST, label: _("Most recent activity")},
        ].concat(visible.map((state) => ({id: state.provider.id, label: state.provider.name})));
        // A pin to a provider that is not shown falls back to automatic.
        const selected = choices.some((choice) => choice.id === this.panelProvider) ? this.panelProvider : "";

        let current;
        if (selected === PANEL_LATEST)
            current = pinned ? _("Most recent activity (%s)").format(pinned.provider.name) : _("Most recent activity");
        else
            current = pinned ? pinned.provider.name : _("Automatic");
        const submenu = new PopupMenu.PopupSubMenuMenuItem(_("Panel shows: %s").format(current));

        for (const choice of choices) {
            const item = new PopupMenu.PopupMenuItem(choice.label);
            item.setOrnament(PopupMenu.OrnamentType.DOT, selected === choice.id);
            item.connect("activate", () => {
                this.panelProvider = choice.id;
                this._render();
            });
            submenu.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(submenu);
    }

    _addInfoItem(text, styleClass) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.clutter_text.line_wrap = true;
        item.label.add_style_class_name("ai-usage-info");
        if (styleClass)
            item.label.add_style_class_name(styleClass);
        this.menu.addMenuItem(item);
    }

    // Progress bar drawn at whatever width the menu gives it. The track is the
    // widget's CSS background; the fill uses its CSS foreground color, which
    // the severity classes change.
    _makeBar(percent, severity) {
        const bar = new St.DrawingArea({style_class: "ai-usage-bar", x_expand: true});
        this._setSeverityClass(bar, severity);
        bar.connect("repaint", (area) => {
            const cr = area.get_context();
            const [width, height] = area.get_surface_size();
            const fill = Math.round((width * Math.min(100, Math.max(0, percent))) / 100);
            if (fill > 0) {
                const color = area.get_theme_node().get_foreground_color();
                const radius = Math.min(height / 2, fill / 2);
                cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
                cr.newSubPath();
                cr.arc(fill - radius, radius, radius, -Math.PI / 2, 0);
                cr.arc(fill - radius, height - radius, radius, 0, Math.PI / 2);
                cr.arc(radius, height - radius, radius, Math.PI / 2, Math.PI);
                cr.arc(radius, radius, radius, Math.PI, 1.5 * Math.PI);
                cr.closePath();
                cr.fill();
            }
            cr.$dispose();
        });
        return bar;
    }

    _addLimitItem(label, percent, detail, stale = false) {
        const severity = this._severity(percent);
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const box = new St.BoxLayout({vertical: true, style_class: "ai-usage-limit", x_expand: true});

        const row = new St.BoxLayout({x_expand: true});
        row.add_child(new St.Label({text: label, x_expand: true, style_class: "ai-usage-limit-name"}));
        const value = new St.Label({text: util.formatPercent(percent), style_class: "ai-usage-limit-value"});
        this._setSeverityClass(value, severity);
        row.add_child(value);
        box.add_child(row);

        box.add_child(this._makeBar(percent, severity));

        if (detail)
            box.add_child(new St.Label({text: detail, style_class: "ai-usage-limit-detail"}));

        if (stale)
            box.opacity = STALE_OPACITY;
        item.addActor(box, {expand: true});
        this.menu.addMenuItem(item);
    }

    // ----- Notifications -------------------------------------------------

    _notifyCriticalLimits() {
        const current = new Set();
        for (const state of this._visibleStates()) {
            const {provider} = state;
            for (const limit of this._displayLimits(state)) {
                if (this._severity(limit.percent) !== util.SEVERITY_CRITICAL)
                    continue;
                const key = `${provider.id}:${limit.id}`;
                current.add(key);
                // Never notify from stale numbers.
                if (!this.notifyCritical || this._notified.has(key) || this._isStale(state))
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

    on_orientation_changed() {
        this._render();
    }

    on_panel_icon_size_changed() {
        this._render();
    }

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
