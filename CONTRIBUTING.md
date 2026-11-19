# Contributing

## Layout

The repository mirrors the structure required by
[cinnamon-spices-applets](https://github.com/linuxmint/cinnamon-spices-applets),
so the `ai-usage@dmcallejo/` directory can be copied into a fork of that
repository as is.

```
ai-usage@dmcallejo/                 What goes into the Spices pull request
  info.json, README.md, CHANGELOG.md, screenshot.png
  files/ai-usage@dmcallejo/         What Cinnamon installs
    applet.js                       Panel label, menu, timers, notifications
    lib/util.js                     Pure helpers (formatting, thresholds)
    lib/errors.js                   ProviderError and ErrorKind
    lib/http.js                     Async libsoup 2/3 wrapper
    lib/files.js                    Async JSON file reader and file watcher
    lib/panel.js                    Pure logic for the panel segments
    providers/anthropic.js          Claude provider
    providers/codex.js              Codex (OpenAI) provider
    providers/kimi.js               Kimi Code (Moonshot AI) provider
    settings-schema.json, stylesheet.css, icons/, po/
tests/                              Node unit tests for the pure modules
assets/                             Source artwork (not shipped)
```

## Rules the code follows

These come from the Spices review guidelines and keep the pull request easy
to review:

- No synchronous I/O: files, network and processes are asynchronous.
- Every timer and request is cancelled in `on_applet_removed_from_panel()`.
- Nothing is written to the applet directory; settings go through
  `Settings.AppletSettings`.
- Translatable strings are complete sentences with `%s`/`%d` tokens.
- No minified code, binaries or compiled translations (`.mo`).
- Network access only to the enabled providers' official domains.
- Modules under `lib/` and `providers/` do not load other modules: Cinnamon
  resolves `require()` paths from the applet directory, not from the calling
  file, so helpers are passed in (`ctx` for providers, `options` for
  `lib/panel.js`).

## Adding a provider

1. Create `files/ai-usage@dmcallejo/providers/<id>.js` exporting a class with
   this interface:

   ```js
   class ExampleProvider {
       constructor(ctx) { this._ctx = ctx; }
       static get id() { return "example"; }          // settings prefix
       static get settingKeys() { return ["api-key"]; } // optional, "<id>-<key>"
       static get homeEnv() { return "EXAMPLE_HOME"; } // CLI config-folder variable
       get id() { return ExampleProvider.id; }
       get name() { return "Example"; }                // shown in the UI
       get dashboardUrl() { return "https://..."; }    // or null
       get iconFile() { return "provider-example-symbolic.svg"; } // in icons/
       watchPaths() { return ["/path/to/credentials"]; } // optional
       async fetch(cancellable) {
           // return {plan, limits: [{id, label, percent, resetsAt}], spend,
           //         blocked} (blocked: optional, true when the service
           //         refuses requests even if no limit shows 100%)
           // throw new ctx.ProviderError(ctx.ErrorKind.AUTH, ctx._("..."))
       }
   }
   module.exports = {ExampleProvider};
   ```

   `ctx` provides `_` (gettext), `util`, `ErrorKind`, `ProviderError`,
   `http.getJSON(url, headers, cancellable)` (resolves `{status, json}`),
   `readJSON(path, cancellable)`, `homeDir`, `getenv(name)` and
   `getSetting(key)`. Providers must not use `imports.*` or `require()` so
   they stay testable under Node.

   When the credentials file does not exist, throw
   `ProviderError(ErrorKind.NOT_FOUND, ...)`: in the default "When signed in"
   mode the applet then hides the provider instead of showing an error.
   Return the credentials path from `watchPaths()` so a new sign-in is
   picked up immediately.

   `percent` is 0 to 100, `resetsAt` a `Date` or `null`, `spend` either
   `null` or `{label, used, limit, currency, percent}`. Put the limit that
   matters most first: the "Main limit" panel text uses it.

2. Register the class in `PROVIDER_CLASSES` in `applet.js`.
3. Draw a 16x16 symbolic SVG in `icons/` (single color `#bebebe`). Do not
   copy the provider's logo: Anthropic and OpenAI both forbid shipping or
   recoloring their marks without permission, and panel icons are recolored
   by the theme.
4. Add an `<id>-mode` combobox (`auto`, `on`, `off`, default `auto`), any
   `<id>-icon` iconfilechooser, any `<id>-<key>` settings, and a section to
   `settings-schema.json`. Copy the Codex entries.
5. Add tests under `tests/` with a fixture of a real (anonymised) response.
6. Run `make pot` and update the translations you can.

Secrets such as API keys should not be stored in plain settings if it can be
avoided; prefer reading the credentials file of the provider's official CLI,
as the Claude provider does, or libsecret.

## Development

```sh
make install     # symlink into ~/.local/share/cinnamon/applets and compile translations
make reload      # reload the running applet after editing
make test        # unit tests (Node 18+)
make check       # tests, syntax check, JSON and translation validation
make pot         # regenerate po/ai-usage@dmcallejo.pot
make uninstall
```

Logs appear in `~/.xsession-errors` and in Looking Glass (`Alt+F2`, `lg`).

## Publishing to Cinnamon Spices

1. Fork `linuxmint/cinnamon-spices-applets` and create a branch.
2. Copy `ai-usage@dmcallejo/` into the root of the fork.
3. Run `./validate-spice ai-usage@dmcallejo` there.
4. Open a pull request titled `ai-usage@dmcallejo: New applet`.
5. For updates, bump `version` in `metadata.json`, update `CHANGELOG.md` and
   open a new pull request from the same account as `info.json`'s `author`.
