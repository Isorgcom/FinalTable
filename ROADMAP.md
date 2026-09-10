# Roadmap

Where FinalTable is going. [CHANGELOG.md](./CHANGELOG.md) is the record of what
has already happened; this is the intent, and it will be wrong in places, which
is the nature of the thing.

## Versioning

Settled:

- Stay on 0.x while in active development.
- Bump the patch for fixes, the minor for backward-compatible features, the
  major on breaking changes.
- Move to 1.0.0 when it is stable and you would hand it to strangers.
- At each milestone: `git tag v0.2.0`, push the tag, then publish a Release on
  GitHub with notes.

## The game itself

None of this waits on the split below, and all of it is visible to a player.

### Table visibility - public, private, invite-only

Today every tournament is public: `GET /api/tournaments` is unauthenticated,
and every game is listed on it. The list used to carry the join code as well,
so anyone who could reach the server could walk into any game; that is fixed,
and a lobby card now joins by id while the code stays in the waiting room.

Three modes: **public** (listed, anyone joins), **private** (unlisted, joinable
only with the code), **invite-only** (the host admits people, or the roster is
fixed up front).

### A real blind structure

There is a thirteen-level ladder in `tournament.js`, fixed, from 10/20 to
1000/2000. `director.js` already accepts a `blindSchedule` option and nothing
ever passes one, so the wiring is half there. Wanted: choosing a structure when
the game is made - turbo, deep, slow - editing the levels, seeing the ladder
before you sit down, and antes, which do not exist at all.

### Re-entry

Busting should not always be the end of it. Re-entry while late registration is
open, re-buys within a level window, add-ons at the break. Needs a decision on
what it does to the prize pool and to the chip-conservation invariant the
director checks after every hand, which currently assumes chips only move
between seats and never appear.

### Watching a table

Half of this exists: a busted player keeps watching the table they were at
(`entry.watching`), and the plumbing serves a spectator view with no hole cards.
What is missing is a way in for somebody who is not in the tournament at all -
a rail link, and a decision about whether watchers can chat.

### Accounts, and preferences that follow you

An identity today is a device token in the browser plus a record in
`identities.json` with a thirty-day expiry, so it survives a restart but is
tied to one browser. Preferences - mute, which chair you sit in, which panel
tab - are `localStorage` only, so they do not follow you to the iPad.

Real accounts, in the sense of a password or a login, are the Identity bridge
below: Game Night owns that. What belongs here is the other half - a
server-side place for preferences to live, keyed by the identity, so the same
person gets the same table on any device.

### More control over your own games

For a player: see and end your own sessions, leave properly rather than by
closing the tab. For a host: more than start and cancel - pause a running game,
kick or mute somebody, adjust a level, rebalance by hand. Some of that arrives
with the API below, but a host with no Game Night should have it too.

### Games other than Hold'em

The largest of these by far. The engine deals two cards and makes the best five
from seven, and `hand-eval.js` assumes exactly that. Omaha changes the deal and
the must-use-two rule; stud changes the whole street structure; draw needs a
discard phase that has no equivalent anywhere in the code. Worth doing as one
deliberate piece of work on the engine's shape rather than as four special
cases bolted to a Hold'em loop.

### Done

Chat landed - table chat, a waiting-room channel before the cards are out, and
a host mute. See the CHANGELOG.

## Architecture

Decided: **two services, two containers.**

- **Game Night** - identity, invites, blinds, payouts, records.
- **Final Table** - live gameplay, and its own web UI.

They talk over an API and webhooks. Neither takes the other down.

## Core API

- An endpoint to launch a game with its settings: blind timers, player count,
  roster.
- It returns a unique game id. Every later call references it.
- Game Night to Final Table: start a game, cancel or end early, pause, and
  request a seat move - advisory only, see Seating authority below.

## Webhook events

Final Table to Game Night:

- Player eliminated, with finishing place
- Re-entry
- Blind level up
- Tournament complete, with final standings

Later if they turn out to be needed: a game-started confirmation, and a
heartbeat.

## Identity bridge

- Game Night stays the single source of truth for accounts, passwords and 2FA.
- A JWT signed with a shared secret; Final Table verifies the signature
  locally.
- The secret lives in environment variables, never in the repository.
- Short expiry, per game or per session, with an optional reject-list so
  somebody can be kicked mid-game.
- The flow: a player logs into Game Night, is redirected to Final Table with
  the token attached, and is seated automatically.

## Seating authority

- Game Night owns seating before the tournament starts.
- Once it is live, Final Table's tournament director owns it - balancing and
  collapsing tables.
- A manual move from Game Night is a request the director may override.

## Standalone mode

Final Table must run without Game Night existing at all.

- A guest username and a session token, plus join-by-URL links.
- Mixed tables are allowed - regulars alongside walk-ins - with guests tagged
  in the data and in the UI.
- The guest-to-account upgrade path is handled on the Game Night side, by
  email invite and username matching.

## Game Night side

Add a third event type alongside invite-only and physical poker: an **online
event**. It is the only type that calls the Final Table API, and it
auto-invites and seats the roster.

## Build order

Suggested, for the split:

1. The game-creation endpoint and the game id
2. The elimination and tournament-complete webhooks
3. The JWT bridge and the redirect flow
4. Re-entry and blind-level events
5. The online event type in Game Night
6. Cancel and pause, the heartbeat, and seat-move requests

The game-side work above is independent of all six and can be picked up in any
order.

## Not on either path

- An admin page. The operator controls are a password and a few socket events;
  there is no screen for them.
