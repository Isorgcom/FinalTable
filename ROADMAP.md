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
- At each milestone, a tag and a Release on GitHub with the notes from the
  changelog. The routine is written down in [CLAUDE.md](./CLAUDE.md); 0.2.0
  and 0.3.0 went out through it.

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

### The host at every table

Asked for on the forum (below): in a field of several tables the host is a
seat at one of them, and chat is per table, so the host can talk to their own
table and nobody else. A host running a night needs to reach every table - a
level change, a break, "we are hand-for-hand". The shape is a host channel
that lands in every table's room at once, distinguishable from a line said at
the table, and readable by the host from every room whether or not they are
seated there - which is the same seam as watching a table, since a host who
busts should keep the whole field in view, not the rail of one table.

### Trust, but verify

The first reply to the announcement was "Rigged!", and that is the right
question to ask a server that deals. Today the answer is by inspection: the
shuffle is Fisher-Yates over `crypto.randomInt`, a player's state carries
nobody's hole cards but their own until they are turned up, and the tests
walk the run-out rules ([SECURITY.md](./SECURITY.md) has the details). That
is a claim a reader has to verify by reading code.

What would let a player verify a hand without reading anything: commit to
the deck at the deal - publish a hash of the shuffled order plus a per-hand
secret - and reveal both at the end of the hand, so anyone with the hand
history can check that the cards that came out were the cards that were
committed to. With an exportable hand history that becomes something a
suspicious player can do at home. It does not prove the shuffle was fair, only
that the deck was not changed after the deal, which is the part that can be
proven.

### Accounts, and preferences that follow you

A guest is still a device token in the browser plus a record in
`identities.json` with a thirty-day expiry, tied to one browser. A Game Night
account is not: it is one identity here with a device token per browser, so
the phone and the iPad are the same player. That half is done (Identity
bridge, below).

What remains is the other half. Preferences - mute, which chair you sit in,
which panel tab - are `localStorage` only, so they still do not follow you.
They want a server-side place to live, keyed by the identity, so the same
person gets the same table on any device. For a Game Night player the key
exists now; for a guest it is the device, which is the best there is.

### More control over your own games

For a player: see and end your own sessions, leave properly rather than by
closing the tab. For a host: more than start and cancel - pause a running game,
kick somebody, adjust a level, rebalance by hand. Mute is done. An operator
(the server's password, not the game's host) can end a running tournament
from the table menu, and has an Operator page in the lobby for the server's
own settings. Some of the rest arrives with the API below, but a host with no
Game Night should have it too.

### Games other than Hold'em

The largest of these by far. The engine deals two cards and makes the best five
from seven, and `hand-eval.js` assumes exactly that. Omaha changes the deal and
the must-use-two rule; stud changes the whole street structure; draw needs a
discard phase that has no equivalent anywhere in the code. Worth doing as one
deliberate piece of work on the engine's shape rather than as four special
cases bolted to a Hold'em loop.

### Done

Chat landed - table chat, a waiting-room channel before the cards are out, and
a host mute. Reactions followed it: a fixed strip of six, thrown from the
pre-action panel, floating over the chair and kept nowhere, past the same mute
and off with one switch.

Signing in with a Game Night account, and the Operator page that pairs a
server with one and changes its own password. The lobby's corner menu, which
is where those live. Deployment by pulling this repository rather than
shipping an image. The join code no longer served in the public list. The
action bubble that used to outlive its street. See the CHANGELOG.

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

Built. What shipped, and what changed from the sketch:

- Game Night is the single source of truth for accounts, passwords and 2FA.
- A JWT signed ES256 with a keypair Game Night holds, rather than a shared
  secret: Final Table verifies with the public key alone, so a leak on this
  side lets nobody mint a token, and rotation touches one place.
- The key lives in environment variables, never in the repository.
- Two-minute expiry, single use, carried in the URL fragment so it reaches no
  access log. The device token that comes back is what every later connect
  uses; Game Night is not consulted again.
- The flow: the lobby's button sends the player to Game Night, which logs them
  in and asks once; they land back seated, with a join link honoured across
  the round trip.

Still to do here: a reject-list or server-side revoke so somebody can be
signed out of every device mid-game (sign-out today is per browser), and a
name reservation so a guest cannot take a Game Night member's display name in
the same tournament (today the second to arrive is refused).

## Seating authority

- Game Night owns seating before the tournament starts.
- Once it is live, Final Table's tournament director owns it - balancing and
  collapsing tables.
- A manual move from Game Night is a request the director may override.

## Standalone mode

Final Table must run without Game Night existing at all.

- A guest username and a session token, plus join-by-URL links. Done, and
  still the whole of what a server with no Game Night needs.
- Mixed tables - regulars alongside walk-ins. Done: every identity carries a
  `provider`, the roster badges a Game Night player, and a guest and a member
  sit at the same table. The one seam left is a guest taking a member's name
  in the same tournament, where the second to arrive is refused.
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
3. ~~The JWT bridge and the redirect flow~~ (done)
4. Re-entry and blind-level events
5. The online event type in Game Night
6. Cancel and pause, the heartbeat, and seat-move requests

The game-side work above is independent of all six and can be picked up in any
order.

## From the table

Feedback, and where it went. Kept so a request is not lost when the thread
scrolls away.

- [PokerChipForum, September 2026](https://www.pokerchipforum.com/threads/working-an-open-sourced-and-free-poker-tournament-server.146533/)
  - the announcement thread, and the first outside play-test.
  - _Thomacetti_ played a session at test.isorg.com: "Everything works well...
    speedy, nice layout." The action bubble outliving its street, and the
    reactions strip, came out of watching that play.
  - _HiveKueen_: "The game host needs to be able to participate in the chat at
    any table." → The host at every table, above.
  - _CraigT78_: "Rigged!" then "Trust, but verify!" → Trust, but verify,
    above, and the fairness notes in [SECURITY.md](./SECURITY.md).
  - _toothpic_: the green screen recalls the OFCP game. Noted; the felt is the
    felt.

## Not on either path

- A full admin console. There is an Operator page now, but it holds the
  server's settings - the Game Night pairing and its own password - and no
  more. The controls over a running game stay in the table menu, behind the
  same password, and are not growing into a dashboard.
