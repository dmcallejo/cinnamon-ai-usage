# Changelog

## 1.1.0

- New Codex provider: 5-hour and weekly Codex limits of a ChatGPT plan, read
  from the Codex CLI sign-in. Off by default.

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
