# Changelog

## 1.1.0

- New Codex provider: 5-hour and weekly Codex limits of a ChatGPT plan, read
  from the Codex CLI sign-in.
- New Kimi provider: Kimi Code membership quota (5-hour, weekly, monthly)
  and extra usage, read from the Kimi Code sign-in.
- Providers show automatically when their sign-in is found, including
  sign-ins made while the applet runs. Each can be set to "Always" or
  "Never" instead.
- The panel shows a symbol per provider next to its percentages, in every
  display mode. Each provider's icon can be replaced with any theme icon or
  image file.
- "Panel shows" selector in the menu: Automatic (most recent activity, the
  default), Highest usage, All providers, or one provider. The last
  activity is remembered across restarts.
- "Panel text" now applies to each provider: Highest limit, Main limit, All
  limits or Icon only.
- When a sign-in expires, the last known numbers stay in the menu, dimmed,
  with the time they were last updated.
- Automatic and Highest usage leave out providers whose data is stale or
  whose limit is used up, unless nothing else is left. Windows that have
  reset since are hidden, and stale numbers never trigger notifications.
- Several accounts per provider: an "Other accounts" list on each provider
  tab, each with its own sign-in folder.
- Settings have one page per provider, so every option fits on screen
  (Cinnamon's settings window cannot scroll).
- Fix: progress bars were too short when the menu was wider than 240 px
  (100% did not fill the bar). Bars now scale with the menu.
- Fix: rate limiting (HTTP 429) was reported as a connection error and the
  15-minute back-off did not apply on libsoup 3.

## 1.0.1

- Refresh as soon as Claude Code renews its sign-in, instead of waiting for
  the next scheduled refresh (up to the refresh interval).
- Clearer hint when the sign-in has expired: Claude Code renews it when it
  sends a request, not just when it is opened.

## 1.0.0

- First release.
- Claude provider: session and weekly limits, extra usage spending.
- Panel display modes, reset countdown, warning and critical colors.
- Notifications when a limit reaches the critical level.
- Spanish and Catalan translations.
