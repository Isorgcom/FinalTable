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
- **Server & networking**: `server.js`, `server/config.js`, `server/http-middleware.js`
- **Frontend**: `public/index.html`, `public/css/`, `public/js/` (`lobby.js` and `socket-client.js` for the lobby; `table-render.js`, `ui-panels.js`, `side-panel.js` for the table)
- **Tests**: `__tests__/` (Jest) and `e2e/` (Playwright; `npx playwright install chromium` once)

## Pull Request Guidelines

1. One feature or fix per PR
2. Add tests for new game logic
3. Preserve self-hosted deployment assumptions: do not force HTTPS in a way that breaks NAS/LAN HTTP setups
4. Code comments in English
5. Run `npm test`, `npm run lint`, and `npm run format:check` before submitting

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected vs actual behavior
- Browser and device info
- Docker logs if applicable (`docker logs finaltable-dev`)
- Whether the deployment is local Node, Docker, reverse proxy, or NAS
