# FinalTable

A self-hosted multi-table tournament poker server.

FinalTable is a fork of [LONICERA](https://github.com/Evostructs/LONICERA), a
single-table Texas Hold'em engine, extended to run tournaments across several
tables at once: seating a field, balancing and breaking tables as players bust,
and merging down to a final table. See [FORK.md](./FORK.md) for lineage, what
was removed, and an important licence caution.

Status: **playable.** Multi-table tournaments run end to end: a lobby where
friends register by code or link, a scheduled start, tables that balance and
break as players bust, late registration, payouts and hand-for-hand at the
bubble, and rejoin after a dropped connection or a page reload. Registrations
survive a server restart; a running tournament does not.

## Running it

```bash
npm install
npm start                 # http://localhost:2026
npm test                  # Jest: engine, director, registry, sockets
npx playwright test       # the lobby, a table and a two-browser tournament
```

Or with Docker:

```bash
docker compose up -d --build
```

The app listens on **2026** inside the container. The compose file publishes it
to loopback only, on the assumption a reverse proxy sits in front.

## Layout

| Path                                                         | Purpose                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `server.js`                                                  | Express + Socket.IO host; wires the identity store, the tournament registry and the handlers    |
| `server/tournament-registry.js`                              | A tournament's life: codes, scheduled start, registrations, host, late entry, rejoin, reaper    |
| `server/tournament-handlers.js`                              | Socket events for tournaments, a thin shim over the registry                                    |
| `server/identity.js`                                         | Who a player is: name + avatar behind a device token (a login backend fills the same interface) |
| `server/tournament-store.js`                                 | Registering tournaments persisted as JSON so a restart keeps them                               |
| `director.js`                                                | `TournamentDirector`: N tables on one clock, seating, balancing, breaking, payouts              |
| `engine.js`                                                  | `PokerGame`: one table, one hand loop, betting and showdown                                     |
| `tournament.js`                                              | Blind schedule, level timer, elimination ledger                                                 |
| `hand-eval.js`, `hand-describe.js`                           | Hand ranking, and the hand in words for the table's readout                                     |
| `npc.js`, `npc-*.js`                                         | Bot decision pipeline (Monte Carlo equity, psychology)                                          |
| `solver-*.js`                                                | Runtime solver lookups the bots consult                                                         |
| `server/socket-handlers.js`, `save-manager.js`               | The single-table room layer, kept for its tests; the lobby no longer uses it                    |
| `public/js/lobby.js`, `socket-client.js`                     | The lobby and the one socket for the life of the page                                           |
| `public/js/table-render.js`, `ui-panels.js`, `side-panel.js` | The table: felt, seats, action bar, the Chat / Info / Stats / History panel                     |
| `__tests__/`, `e2e/`                                         | Jest suites and Playwright specs                                                                |

## Roadmap

Done: the multi-table director (chips carried across tables under a
conservation invariant, one shared clock, balancing and breaking, payouts and
hand-for-hand at the bubble), the table redesign, and the tournament lobby
(identity, scheduled starts, late registration, rejoin, persistence).

Not built, in the order they are likely to matter:

- Railbird spectating for people who are not registered
- Restoring a running tournament after a restart (between hands)
- Re-entry during late registration; kicking a registrant
- A GameNight-account login behind `server/identity.js`
- Player chat in the Chat tab; custom blind schedules; an admin page

## Licence

GNU GPL v3.0 with an appended anti-gambling restriction inherited from
upstream. Read [LICENSE](./LICENSE) and the caution in
[FORK.md](./FORK.md) before deploying anywhere money changes hands.
