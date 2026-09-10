# Contributing to FinalTable

Thanks for your interest! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/Isorgcom/FinalTable.git
cd FinalTable
npm install
npm start
```

Open `http://localhost:2026`. Changes to files take effect after restarting the server.

## Running Tests

```bash
npm test
npm run lint
npm run format:check
npx playwright test
```

All checks must pass before submitting a PR.

## Project Structure

- **Poker**: `engine.js` (one table), `director.js` (many tables on one clock), `tournament.js` (blind clock and ledger), `hand-eval.js`, `hand-describe.js`
- **Tournament lifecycle**: `server/tournament-registry.js` (the state machine), `server/tournament-handlers.js` (socket shim), `server/identity.js` (who a player is), `server/tournament-store.js` (what survives a restart)
- **Chat**: `server/chat-rooms.js` (who may say what, and what is kept), `server/chat-store.js` (chat that survives a restart), `public/js/chat.js` (the composer and the message rows)
- **Server & networking**: `server.js`, `server/config.js`, `server/http-middleware.js`
- **Frontend**: `public/index.html`, `public/css/`, `public/js/` (`lobby.js` and `socket-client.js` for the lobby; `table-render.js`, `ui-panels.js`, `side-panel.js` for the table)
- **Tests**: `__tests__/` (Jest) and `e2e/` (Playwright; `npx playwright install chromium` once)
- **Docs**: `README.md` (what it does and how to run it), `CHANGELOG.md` (what changed), `ROADMAP.md` (where it is going), `FORK.md` (lineage and licence), `CLAUDE.md` (the working rules)

## The Changelog

Anything a player or an operator would notice goes in
[CHANGELOG.md](./CHANGELOG.md) under `## Unreleased`, in the same commit as the
change. Write it from the outside - what is different at the table or in the
lobby, not which module moved. Refactors, renames, test-only work and
formatting do not earn an entry; the commit message is the right place for
those.

Releases are cut by moving `## Unreleased` under a `## X.Y.Z - YYYY-MM-DD`
heading, matching `version` in `package.json`, and pushing a `vX.Y.Z` tag,
which is what publishes a container image.

## Pull Request Guidelines

1. One feature or fix per PR
2. Add tests for new game logic
3. A CHANGELOG.md entry for anything a player or an operator would notice
4. Preserve self-hosted deployment assumptions: do not force HTTPS in a way that breaks NAS/LAN HTTP setups
5. Code comments in English
6. Run `npm test`, `npm run lint`, `npm run format:check` and `npx playwright test` before submitting

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected vs actual behavior
- Browser and device info
- Docker logs if applicable (`docker logs finaltable-dev`)
- Whether the deployment is local Node, Docker, reverse proxy, or NAS
