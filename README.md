# FinalTable

A self-hosted multi-table tournament poker server.

FinalTable is a fork of [LONICERA](https://github.com/Evostructs/LONICERA), a
single-table Texas Hold'em engine, extended to run tournaments across several
tables at once: seating a field, balancing and breaking tables as players bust,
and merging down to a final table. See [FORK.md](./FORK.md) for lineage, what
was removed, and an important licence caution.

Status: **phase 1.** The single-table base is stripped, tested and running.
Multi-table orchestration is not built yet.

## Running it

```bash
npm install
npm start                 # http://localhost:2026
npm test                  # 139 tests, 15 suites
```

Or with Docker:

```bash
docker compose up -d --build
```

The app listens on **2026** inside the container. The compose file publishes it
to loopback only, on the assumption a reverse proxy sits in front.

## Layout

| Path | Purpose |
|---|---|
| `server.js` | Express + Socket.IO host; owns the room map and socket events |
| `engine.js` | `PokerGame`: one table, one hand loop, betting and showdown |
| `tournament.js` | Blind schedule, level timer, elimination ledger |
| `npc.js`, `npc-*.js` | Bot decision pipeline (Monte Carlo equity, psychology) |
| `solver-*.js` | Runtime solver lookups the bots consult |
| `hand-eval.js` | Hand ranking |
| `save-manager.js` | Room persistence as JSON |
| `public/` | Browser client |
| `__tests__/` | Jest suites |

## Roadmap

Multi-table work is specced in phases. Phase 3 is the first genuinely useful
milestone, a synchronised multi-table Sit-and-Go.

1. **Strip and stand up** — done
2. Carry chips across tables, with a chip-conservation invariant
3. `TournamentDirector` owning N tables and one shared clock
4. Balancing and breaking
5. Payouts and hand-for-hand at the bubble
6. Field UI

## Licence

GNU GPL v3.0 with an appended anti-gambling restriction inherited from
upstream. Read [LICENSE](./LICENSE) and the caution in
[FORK.md](./FORK.md) before deploying anywhere money changes hands.
