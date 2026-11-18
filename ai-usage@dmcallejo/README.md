# AI Usage Limits

See how much of your AI subscription limits you have used, straight from the
Cinnamon panel, and when each limit resets.

Currently supported:

- **Claude** (Pro, Max, Team and Enterprise plans): current session, weekly
  limits and extra usage spending.
- **Codex** (ChatGPT Plus, Pro, Business and other plans with Codex): 5-hour
  and weekly limits.
- **Kimi** (Kimi membership plans with Kimi Code): 5-hour window, weekly
  quota on legacy plans, monthly quotas and extra usage when reported.

Each provider appears automatically when its sign-in is found, and also when
you sign in later while the applet is running. You can force a provider to
always or never show in the settings. The applet is built around providers,
so more services can be added later.

## Features

- A symbol per provider in the panel, so you can tell which one each
  percentage belongs to. Choose your own icon or image per provider if you
  prefer.
- Panel text with the highest usage, the main limit of each provider, every
  limit, or just the icons.
- Optional countdown to the next reset in the panel.
- Popup menu with a progress bar, percentage and reset time for every limit.
- "Panel shows" in the menu to pin one provider to the panel, or go back to
  automatic. Automatic skips providers whose limit is used up or whose
  sign-in has expired, so the panel shows what you can still use. They stay
  in the menu, and appear in the panel again when nothing else is left.
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
  Claude Code for a while the applet shows "sign-in has expired". Sending
  any message in Claude Code renews it, and the applet notices the new
  sign-in within a couple of seconds.
- The usage endpoint is the one Claude Code uses, not a documented public API.
  If Anthropic changes it, the applet shows an error until it is updated.
- Anthropic API keys have rate limits, not plan limits, so they are not
  supported.

### Codex

You need to be signed in to the Codex CLI with your ChatGPT account
(`codex login`). The applet reads `~/.codex/auth.json` (or
`$CODEX_HOME/auth.json`) and asks `chatgpt.com` for your limits, the same way
Codex's `/status` command does.

- These are the Codex limits of your ChatGPT plan. Message limits of the
  ChatGPT chat apps are not available from OpenAI and are not shown.
- The file is only read, the token is only sent to `chatgpt.com`, and the
  account details included in the response are ignored.
- The endpoint is not a documented public API and may change.
- Sign-ins that use an OpenAI API key have no plan limits and are not
  supported.

### Kimi

You need to be signed in to Kimi Code (`/login` inside Kimi Code). The applet
finds the sign-in and the API endpoint through Kimi Code's own
`~/.kimi-code/config.toml` (or `$KIMI_CODE_HOME`) and asks Kimi for your
quota, the same way Kimi Code's `/usage` command does. The token is only
sent to `api.kimi.com` or `api.kimi.ai`.

- Kimi Code's sign-in lasts about 15 minutes and is renewed while Kimi Code
  runs. When Kimi Code has not run for a while the menu keeps the last known
  numbers, dimmed and with the time they were last updated, and the panel
  leaves Kimi out. Both update again as soon as Kimi Code renews the
  sign-in.

- The endpoint is not a documented public API. Kimi has a known bug where
  some percentages read 0% during real use; when the response also contains
  the raw counters, the applet uses the higher value.
- Moonshot AI Open Platform API keys (`api.moonshot.ai`) have a balance, not
  plan limits, and are not supported.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Panel text | Highest usage | Which percentages appear next to the icon |
| Show time until reset in the panel | On | Only when a single limit is shown |
| Show extra usage spending in the menu | On | Pay-as-you-go credits, if enabled on your plan |
| Refresh every | 5 minutes | 1 to 60 minutes |
| Warning / Critical level | 75% / 90% | Colors and notifications |
| Show Claude usage | When signed in | Or Always / Never |
| Claude Code credentials file | empty | Custom path to `.credentials.json` |
| Show Codex usage | When signed in | Or Always / Never |
| Panel icon (per provider) | built-in symbol | Any theme icon or image file |
| Codex CLI credentials file | empty | Custom path to `auth.json` |
| Show Kimi usage | When signed in | Or Always / Never |
| Kimi Code credentials file | empty | Custom path to `kimi-code.json` |

## Icons

The built-in provider symbols are generic drawings made for this applet. They
are not the logos of Anthropic, OpenAI or Moonshot AI. Anthropic's and
OpenAI's trademark guidelines do not allow logos to be shipped or recolored
without permission. If you want a
different picture in your own panel, pick it under **Panel icon**; images
keep their own colors, symbolic icons follow the panel theme.

## Privacy

The applet talks only to the providers you enable. Nothing is stored apart
from Cinnamon's own applet settings.
