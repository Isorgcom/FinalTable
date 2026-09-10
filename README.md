# FinalTable

A self-hosted multi-table tournament poker server.

FinalTable is a fork of [LONICERA](https://github.com/Evostructs/LONICERA), a
single-table Texas Hold'em engine, extended to run tournaments across several
tables at once: seating a field, balancing and breaking tables as players bust,
and merging down to a final table. See [FORK.md](./FORK.md) for lineage, what
was removed, and an important licence caution, and
[CHANGELOG.md](./CHANGELOG.md) for what has changed since.

Status: **playable.** Multi-table tournaments run end to end: a lobby where
friends register by code or link, a scheduled start, tables that balance and
break as players bust, late registration, payouts and hand-for-hand at the
bubble, and rejoin after a dropped connection or a page reload. Registrations
survive a server restart, and so does a running field: it is recorded between
hands, never during one, and seated again on the way back up.

It is people, unless you ask for otherwise: a tournament needs two entrants
before it can deal, and the create form has a box that adds five demo seats so
you can fill a table on your own and watch it play. They are donkeys on
purpose - they call far too much and raise for no reason - and they are there
to show the game moving, not to be beaten. A seat whose player disconnects,
leaves or runs out their clock is never played for them: it sits out, checking
when that is free and folding to a bet, and the stack blinds down until they
come back or bust.

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

For a server too small to build its own image, build it elsewhere and hand it
over SSH - see [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

## Capacity

Measured rather than estimated, against a container held to
`--max-old-space-size=256` and a 384 MB limit - the settings a small VPS gets.
Fields of bots, every seat acting without pausing to think, which is harder than
the same number of people:

| Field                  | Result                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| 80 players, 10 tables  | Stable. 20 hands, memory levelled at 199-243 MB and stayed there. |
| 150 players, 19 tables | Dies inside three minutes: `JavaScript heap out of memory`.       |

So **about 80 players** at those settings. The limit is V8's heap, not the
container - Docker never intervened, `oomKilled=false`; Node gave up first. It
scales with concurrent _tables_ rather than with players alone, because a table
costs a deck, a hand history, timers and per-player state, and every action fans
out to everyone sitting at it.

For a larger field, raise the two together:

```yaml
- NODE_OPTIONS=--max-old-space-size=384   # from 256
mem_limit: 512m                            # from 384m
```

Raising one alone only changes which limit is hit first. 640 MB of heap carries a
200 player field.

One thing to know before reading `docker stats`: given headroom, Node grows into
it and does not collect until it has to, so resident memory tracks the ceiling
you set rather than the work being done. The same 80 player field sat at 298 MB
and climbing under a 640 MB ceiling, and settled at 220 MB under a 256 MB one.
Rising memory is not the signal - whether it levels off below the ceiling is.

Tables seat up to 8. The figures above are memory; CPU was never the constraint,
but they were taken on a host with more of it than a 1 vCPU VPS has, so treat 80
as the memory ceiling and watch the clock separately on a small box.

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
| `public/js/lobby.js`, `socket-client.js`                     | The lobby and the one socket for the life of the page                                           |
| `public/js/table-render.js`, `ui-panels.js`, `side-panel.js` | The table: felt, seats, action bar, the Chat / Info / Stats / History panel                     |
| `__tests__/`, `e2e/`                                         | Jest suites and Playwright specs                                                                |

## Roadmap

Done: the multi-table director (chips carried across tables under a
conservation invariant, one shared clock, balancing and breaking, payouts and
hand-for-hand at the bubble), the table redesign, the tournament lobby
(identity, scheduled starts, late registration, rejoin, persistence), and
restoring a running field after a restart.

Chat is the first thing the server keeps that people wrote rather than played:
the last hundred lines of each room are held in memory and written to
`data/chat/<tournament>.json`, and both go when the tournament is reaped.
`CHAT_ENABLED=false` turns the whole surface off, and `CHAT_HISTORY=0` keeps
the chat without keeping any of it.

Next is splitting the work in two: Game Night owning identity, invites and
records, FinalTable owning the live game, talking over an API and webhooks so
neither can take the other down - and FinalTable still running on its own for
anyone who has no Game Night. See [ROADMAP.md](./ROADMAP.md) for the shape of
that and what comes in what order.

## Licence

GNU GPL v3.0. See [LICENSE](./LICENSE) for the full text. An anti-gambling
restriction inherited from upstream has been removed under section 7 of that
licence; [FORK.md](./FORK.md) explains the reasoning and what it does not
change.
