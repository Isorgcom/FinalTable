# FinalTable

A self-hosted multi-table tournament poker server.

FinalTable is a fork of [LONICERA](https://github.com/Evostructs/LONICERA), a
single-table Texas Hold'em engine, extended to run tournaments across several
tables at once: seating a field, balancing and breaking tables as players bust,
and merging down to a final table. See [FORK.md](./FORK.md) for lineage, what
was removed, and an important licence caution, and
[CHANGELOG.md](./CHANGELOG.md) for what has changed since.

There is a [user manual](./docs/MANUAL.md) for players, hosts and operators.

Status: **playable.** Multi-table tournaments run end to end: a lobby where
friends register by code or link, a scheduled start, a blind structure the
host picks or edits with antes and breaks, a host who can pause the game,
step the level, and move or remove a player, tables that balance and break as
players bust, late registration, payouts and hand-for-hand at the bubble, and
rejoin after a dropped connection or a page reload. Registrations
survive a server restart, and so does a running field: it is recorded between
hands, never during one, and seated again on the way back up - and cleared,
like any other table everyone has left, if nobody comes back to it.

It is people, unless you ask for otherwise: a tournament needs two entrants
before it can deal, and the create form has a box that adds up to eight demo
seats so you can fill a table on your own and watch it play. They are donkeys on
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

| Path                                                         | Purpose                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `server.js`                                                  | Express + Socket.IO host; wires the identity store, the tournament registry and the handlers |
| `server/tournament-registry.js`                              | A tournament's life: codes, scheduled start, registrations, host, late entry, rejoin, reaper |
| `server/tournament-handlers.js`                              | Socket events for tournaments, a thin shim over the registry                                 |
| `server/identity.js`                                         | Who a player is: a guest name, or a GameNight account, behind device tokens                  |
| `server/gamenight-sso.js`                                    | Checks the signed token a player brings back from GameNight, with only the public key        |
| `server/gamenight-pairing.js`, `settings-store.js`           | The pairing itself: fetched from GameNight by the operator, kept in `data/settings.json`     |
| `server/tournament-store.js`                                 | Registering tournaments persisted as JSON so a restart keeps them                            |
| `director.js`                                                | `TournamentDirector`: N tables on one clock, seating, balancing, breaking, payouts           |
| `engine.js`                                                  | `PokerGame`: one table, one hand loop, betting and showdown                                  |
| `tournament.js`                                              | Blind schedule, level timer, elimination ledger                                              |
| `blind-structures.js`                                        | The Turbo, Standard and Deep presets, the clamp on a hand-edited structure, the rung rule    |
| `hand-eval.js`, `hand-describe.js`                           | Hand ranking, and the hand in words for the table's readout                                  |
| `public/js/lobby.js`, `socket-client.js`                     | The lobby and the one socket for the life of the page                                        |
| `public/js/table-render.js`, `ui-panels.js`, `side-panel.js` | The table: felt, seats, action bar, the Chat / Info / Stats / History panel                  |
| `__tests__/`, `e2e/`                                         | Jest suites and Playwright specs                                                             |

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
the chat without keeping any of it. Reactions ride the same rooms and the same
mute: a few emoji thrown from the pre-action strip that float over the chair
and are kept nowhere. `REACTIONS_ENABLED=false` removes them. The host reads
and talks at every table: a strip in the Chat tab picks a table, and All
announces to every table at once and over the felt.

A game is private unless its host lists it: friends come in by code or link, a
public game is on the lobby list for anyone, and an invite-only game has a door
the host works. Identity is now shared with Game Night, optionally: a server paired with one
(from the lobby's Operator page, behind the admin password; see
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)) offers "Sign in with GameNight",
and a player who signs in there is seated here under their Game Night
username, the same player on every device. Guests still type a name; a server
with no Game Night is still whole. The same Operator page lists every game the
server holds, listed or not, with its code, and can end one.

A blind structure is chosen when a game is made, Turbo, Standard or Deep, or
edited level by level: blinds, a big-blind ante, length, breaks. The ladder is
in the waiting room and the Info tab; a break holds every table until the
clock moves on. A level is a row of the same shape Game Night's blind editor
keeps, so a structure can come across from there when the API below exists.

The host runs the night from the table's Info tab: pause and resume, a level
back or forward, a minute on or off the clock, a player moved to a smaller
table, a player removed from the game. Every action is checked again on the
server. The create form's bot box takes a count, one to eight, and a table
the field is waiting on sits out a hand so tables merge and balance even
when they never rest at the same moment.

Next is the rest of that split: Game Night owning invites and records,
FinalTable owning the live game, talking over an API and webhooks so neither
can take the other down. See [ROADMAP.md](./ROADMAP.md) for the shape of that
and what comes in what order.

## Licence

GNU GPL v3.0. See [LICENSE](./LICENSE) for the full text. An anti-gambling
restriction inherited from upstream has been removed under section 7 of that
licence; [FORK.md](./FORK.md) explains the reasoning and what it does not
change.
