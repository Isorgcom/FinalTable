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
```

All checks must pass before submitting a PR.

## Project Structure

- **Poker**: `engine.js` (one table), `director.js` (many tables on one clock), `tournament.js` (blind clock and ledger), `hand-eval.js`, `hand-describe.js`
- **Tournament lifecycle**: `server/tournament-registry.js` (the state machine), `server/tournament-handlers.js` (socket shim), `server/identity.js` (who a player is), `server/tournament-store.js` (what survives a restart)
- **Bots**: `npc.js`, `npc-*.js`, `solver-*.js`
- **Server & networking**: `server.js`, `server/config.js`, `server/http-middleware.js`; `server/socket-handlers.js` and `save-manager.js` are the older single-table room layer, kept for its tests
- **Frontend**: `public/index.html`, `public/css/`, `public/js/` (`lobby.js` and `socket-client.js` for the lobby; `table-render.js`, `ui-panels.js`, `side-panel.js` for the table)
- **Tests**: `__tests__/` (Jest) and `e2e/` (Playwright; `npx playwright install chromium` once)

## Pull Request Guidelines

1. One feature or fix per PR
2. Add tests for new game logic
3. Preserve self-hosted deployment assumptions: do not force HTTPS in a way that breaks NAS/LAN HTTP setups
4. NPC names stay in Chinese with English subtitles; all UI text in English
5. Code comments in English
6. Run `npm test`, `npm run lint`, and `npm run format:check` before submitting

## Adding a New NPC

1. Add a profile object to `NPC_PROFILES` in `npc.js`
2. Set `origin` to the literary/historical source
3. The selection algorithm (`getAvailableNPCs`) limits 2 NPCs per origin per table

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected vs actual behavior
- Browser and device info
- Docker logs if applicable (`docker logs finaltable`)
- Whether the deployment is local Node, Docker, reverse proxy, or NAS
