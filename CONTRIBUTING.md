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
    lib/files.js                    Async JSON file reader
    providers/anthropic.js          Claude provider
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

## Adding a provider (for example OpenAI)

1. Create `files/ai-usage@dmcallejo/providers/<id>.js` exporting a class with
   this interface:

   ```js
   class ExampleProvider {
       constructor(ctx) { this._ctx = ctx; }
       static get id() { return "example"; }          // settings prefix
       static get settingKeys() { return ["api-key"]; } // optional, "<id>-<key>"
       get id() { return ExampleProvider.id; }
       get name() { return "Example"; }                // shown in the UI
       get dashboardUrl() { return "https://..."; }    // or null
       async fetch(cancellable) {
           // return {plan, limits: [{id, label, percent, resetsAt}], spend}
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

   `percent` is 0 to 100, `resetsAt` a `Date` or `null`, `spend` either
   `null` or `{label, used, limit, currency, percent}`. Put the limit that
   matters most first: the "Main limit of each provider" panel mode uses it.

2. Register the class in `PROVIDER_CLASSES` in `applet.js`.
3. Add `<id>-enabled` (and any `<id>-<key>` settings) plus a section to
   `settings-schema.json`.
4. Add tests under `tests/` with a fixture of a real (anonymised) response.
5. Run `make pot` and update the translations you can.

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
