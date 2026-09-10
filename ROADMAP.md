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

Suggested:

1. The game-creation endpoint and the game id
2. The elimination and tournament-complete webhooks
3. The JWT bridge and the redirect flow
4. Re-entry and blind-level events
5. The online event type in Game Night
6. Cancel and pause, the heartbeat, and seat-move requests

## Not on the path

Wanted, but not part of the integration work above:

- Railbird spectating for people who are not registered
- Re-entry during late registration; kicking a registrant
- Custom blind schedules; an admin page
