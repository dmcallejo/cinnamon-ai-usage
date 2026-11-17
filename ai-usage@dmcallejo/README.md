# AI Usage Limits

See how much of your AI subscription limits you have used, straight from the
Cinnamon panel, and when each limit resets.

Currently supported:

- **Claude** (Pro, Max, Team and Enterprise plans): current session, weekly
  limits and extra usage spending.

The applet is built around providers, so more services can be added later.

## Features

- Panel text with the highest usage, the main limit of each provider, every
  limit, or just the icon.
- Optional countdown to the next reset in the panel.
- Popup menu with a progress bar, percentage and reset time for every limit.
- Warning and critical colors with configurable thresholds.
- Desktop notification when a limit reaches the critical level.
- Middle click, or "Refresh now" in the menu, to update immediately.
- Translations: English, Spanish, Catalan.

## Requirements

### Claude

You need to be signed in to Claude Code with your Claude subscription account
(`/login` inside Claude Code). The applet
reads the sign-in that Claude Code stores in `~/.claude/.credentials.json`
(or `$CLAUDE_CONFIG_DIR/.credentials.json`) and asks
`api.anthropic.com` for your usage, the same way Claude Code's `/usage`
command does.

Good to know:

- The credentials file is only read. The applet never refreshes or rewrites
  your sign-in, and the token is only sent to `api.anthropic.com`.
- Claude Code renews its sign-in while you use it. If you have not used
  Claude Code for a while the applet shows "sign-in has expired"; opening
  Claude Code fixes it.
- The usage endpoint is the one Claude Code uses, not a documented public API.
  If Anthropic changes it, the applet shows an error until it is updated.
- Anthropic API keys have rate limits, not plan limits, so they are not
  supported.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Panel text | Highest usage | Which percentages appear next to the icon |
| Show time until reset in the panel | On | Only when a single limit is shown |
| Show extra usage spending in the menu | On | Pay-as-you-go credits, if enabled on your plan |
| Refresh every | 5 minutes | 1 to 60 minutes |
| Warning / Critical level | 75% / 90% | Colors and notifications |
| Claude Code credentials file | empty | Custom path to `.credentials.json` |

## Privacy

The applet talks only to the providers you enable. Nothing is stored apart
from Cinnamon's own applet settings.
