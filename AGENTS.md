# Chek Tools

Personal Stream Deck plugin (Elgato SDK v3, Node.js 26, TypeScript, rollup). One person's work hub, not for publishing.

- `src/actions/` — the two Stream Deck keys: Open Dashboard and Refresh.
- `src/services/` — one service per source (GitHub, GitLab, Jira, AI review) plus the refresh orchestrator used by the key, the dashboard button and the deep link, and the bookmarks service that mirrors global settings into the store. Each shells out to an already-authenticated CLI (`gh`, `glab`, `acli`, `pi`) and writes results into the store. Services throw; actions catch.
- `src/plugin-store.ts` — the single dashboard state, persisted to `~/.chek-tools/dashboard.json`.
- `src/lib/server.ts` — serves `com.chektek.chek-tools.sdPlugin/dashboard/index.html` and the state on localhost:48616.
- `src/services/review-service.ts` — runs pi non-interactively with each review model and parses its JSON.

Never add auth handling. Link to the source platform wherever possible (file and line on PRs, ticket pages on Jira).
