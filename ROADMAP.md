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
  through 0.10.0 went out through it.

## The game itself

None of this waits on the split below, and all of it is visible to a player.

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
closing the tab. The host's half is done: pause a running game, remove
somebody, step the level or put a minute on it, move a player by hand, and
mute. An operator (the server's password, not the game's host) can end a
running tournament from the table menu or from the Operator page, which holds
the server's own settings and a list of every game on it. Some of the rest
arrives with the API below, but a host with no Game Night should have it too.

### Games other than Hold'em

The largest of these by far. The engine deals two cards and makes the best five
from seven, and `hand-eval.js` assumes exactly that. Omaha changes the deal and
the must-use-two rule; stud changes the whole street structure; draw needs a
discard phase that has no equivalent anywhere in the code. Worth doing as one
deliberate piece of work on the engine's shape rather than as four special
cases bolted to a Hold'em loop.

### Done

Re-entry and the add-on: a host allows re-entry through a level, or not, and
an add-on at the first break, or not; a busted player is offered the way back
in from the bust-out dialog and the Info tab, and a seated one the extra
stack during the break. The two decisions made: each pays a buy-in into the
pool while the places paid follow the number of people, and the chip ledger
takes a re-entry as it takes a late entrant. The re-buy within a level
window turned out to be the same mechanism as re-entry, so there is one
setting. With it, the break on the felt: the table cleared once the last
hand's result has been read, and the middle of it counting the break down.

Watching a table: a rail link on every game, a second code that looks and
never seats, a Watch button on a public card, the busted player's view for
whoever opens it, a block to switch tables, and the decision on chat made:
watchers talk at the table they watch, badged rail, mutable by the host.
With it, the dealer's log in its own tab beside Chat, and the bot box up to
forty, so one person can raise the four-table field the rail was tried on.

The host's controls at the table: pause and resume, a level back or forward,
a minute on or off the clock, a player moved to a smaller table by hand, a
player removed from the game. All in the Info tab, all checked on the server.
With them, a bot count on the create form, so one person can raise a field
of two tables, and the fix that came out of trying it: a table the field is
waiting on sits out a hand, so tables merge and balance even when they never
rest at the same moment.

A real blind structure: Turbo, Standard or Deep when a game is made, or the
levels edited by hand; antes, posted by the big blind from the level the
structure says; breaks, which every table sits out; and the ladder in the
waiting room and the Info tab before anyone sits down. What a host cannot do
yet is change a level once the game is running, which stays under More
control, below.

The host at every table: a strip in the host's Chat tab reads and answers
any table, All announces to every table at once and over the felt, and the
host hears every room live. Asked for on the forum, below. And a user manual,
[docs/MANUAL.md](./docs/MANUAL.md), for players, hosts and operators, which
opens with what each release added and where to read about it.

The Operator page lists every game the server holds, listed or not, with its
code, who is connected, who is waiting at the door, and End game on each: the
view that table visibility took away from the lobby list, given back to the
one person entitled to it. And a page that outlives a deploy reloads itself:
the server says which build it serves, and a page served an older one reloads
from the lobby at once or, from a table, once the table is left. Phones keep a
tab alive for days, and one of them was the first to knock on an invite-only
game with scripts that had never heard of the door.

Table visibility: public, private (the default) and invite-only, the last
with a door the host works from the waiting room or the table's Info tab. A
roster fixed up front, rather than admitting on request, is the variant left
for the Game Night online-event work.

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

- An endpoint to launch a game with its settings: the blind structure, player
  count, roster. A level here is `{ sb, bb, ante, duration, break }`, one to
  one with a row of Game Night's blind editor, so a structure can travel as it
  is; the server's own presets and clamp live in `blind-structures.js`.
- It returns a unique game id. Every later call references it.
- Game Night to Final Table: start a game, cancel or end early, pause, and
  request a seat move - advisory only, see Seating authority below.

## Webhook events

Final Table to Game Night:

- Player eliminated, with finishing place
- Re-entry
- Blind level up. The server already tells every client (`tournamentLevelUp`,
  break or level, with the blinds and the time to the next); the webhook is
  the same event sent outward.
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
    any table." → Done: the host reads and talks at every table.
  - _CraigT78_: "Rigged!" then "Trust, but verify!" → Trust, but verify,
    above, and the fairness notes in [SECURITY.md](./SECURITY.md).
  - _toothpic_: the green screen recalls the OFCP game. Noted; the felt is the
    felt.

## Not on either path

- A full admin console. There is an Operator page now, but it holds the
  server's settings - the Game Night pairing and its own password - and a
  list of every game the server holds, with the one control the operator
  already had: ending one. The controls over a running game stay in the table
  menu, behind the same password, and are not growing into a dashboard.
