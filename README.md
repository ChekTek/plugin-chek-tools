# Chek Tools

A personal Stream Deck plugin that acts as a work hub. Keys trigger local automations and the results land on a dashboard served from the plugin at http://localhost:48616/.

Everything runs through CLIs that are already signed in on this machine. The plugin never handles credentials itself.

## Actions

| Key | What it does |
| --- | --- |
| Open Dashboard | Opens the dashboard in the default browser. Its property inspector holds the dashboard's bookmarks (shared by every Open Dashboard key) as chips: enter a name and URL (name optional), remove with the chip's ×. |
| Refresh | Runs the three sources below at once. The dashboard's refresh button and the deep link `streamdeck://plugins/message/com.chektek.chek-tools/refresh` do the same. |

Sources:

- **GitHub**: unread notifications via `gh`. Each pull request is reviewed by Astra and then Opus 5.5 (both via pi and the Copilot subscription). Other notifications are listed with links.
- **GitLab**: pending to-dos via `glab`, with the same review of merge requests.
- **Jira**: your in-progress work items via `acli`. After a successful refresh, the Jira heading opens the board set by `BOARD_ID` in `src/services/jira-service.ts` on your authenticated site.

Review findings link straight to the file and line on GitHub or GitLab. A pull request is only re-reviewed when its head commit changes. Merged or closed PRs, and PRs you already approved at their current head, are hidden.

State is persisted at `~/.chek-tools/dashboard.json`, so the dashboard survives plugin restarts.

## Required CLI tools

All of these must be installed and authenticated before the keys work.

| Tool | Install | Sign in | Used for |
| --- | --- | --- | --- |
| [gh](https://cli.github.com) | `brew install gh` | `gh auth login` | GitHub notifications, PR metadata and diffs |
| [glab](https://gitlab.com/gitlab-org/cli) | `brew install glab` | `glab auth login` | GitLab to-dos, MR metadata and diffs |
| [acli](https://developer.atlassian.com/cloud/acli/) | `brew install acli` | `acli jira auth login` | Jira work item search |
| [pi](https://github.com/badlogic/pi-mono) | `pnpm add -g @mariozechner/pi-coding-agent` | `pi` then `/login` and pick GitHub Copilot | Runs the review models |

Check pi can reach Copilot with:

```bash
pi auth check --provider github-copilot
```

The plugin looks for these binaries in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and every nvm node version's `bin`, because Stream Deck launches plugins with a minimal `PATH`.

## Development

Uses Elgato SDK v3 and Stream Deck's Node.js 26 runtime. Requires Stream Deck 7.1 or newer; use Node.js 26 and pnpm for development.

```bash
nvm install
pnpm install
pnpm build
streamdeck link com.chektek.chek-tools.sdPlugin
streamdeck restart com.chektek.chek-tools
```

`pnpm watch` rebuilds and restarts the plugin on every change. Logs are in `com.chektek.chek-tools.sdPlugin/logs/`.

Review models are set in `src/services/review-service.ts`. The dashboard port is set in `src/lib/server.ts`.

Key and action icons are [Material Icons](https://fonts.google.com/icons) (Apache 2.0), stored as plain SVG under `imgs/actions/`.
