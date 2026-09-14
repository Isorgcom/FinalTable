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

### Taking the hand history with you

The server already records every hand in full, and a player is already sent
the part of it they are entitled to see. What is missing is a way to keep it.
A download of your own history - the hands as the replay panel has them, your
own holding plus whatever was genuinely turned face up - is worth having for
its own sake: to look at a spot again after the game, to settle an argument at
the table, to paste a hand into a thread.

Three things about the recorder shape it. It keeps the last twenty hands and
sends ten, so the window is short. It lives in memory and is not in the
tournament snapshot, so a restart loses it. And it belongs to a table, so a
player moved when the field balances leaves the old table's hands behind. An
export that is worth downloading probably wants at least the first of those
fixed, and the redaction has to survive the trip: what lands in the file is
what that player could already see, never the table's folded cards.

### Games other than Hold'em

The largest of these by far. The engine deals two cards and makes the best five
from seven, and `hand-eval.js` assumes exactly that. Omaha changes the deal and
the must-use-two rule; stud changes the whole street structure; draw needs a
discard phase that has no equivalent anywhere in the code. Worth doing as one
deliberate piece of work on the engine's shape rather than as four special
cases bolted to a Hold'em loop.

### Trust, but verify

Moved down deliberately, not abandoned. The first reply to the announcement
was "Rigged!", and that is the right question to ask a server that deals.
Today the answer is by inspection: the shuffle is Fisher-Yates over
`crypto.randomInt`, a player's state carries nobody's hole cards but their own
until they are turned up, and the tests walk the run-out rules
([SECURITY.md](./SECURITY.md) has the details). For open source that is a
stronger position than it sounds, because the reader can check the shuffle
itself rather than only the delivery.

What would let a player verify a hand without reading anything: commit to the
deck at the deal - publish a hash of the shuffled order plus a per-hand secret

- and reveal both afterwards, so anyone with the hand history can check that
  the cards that came out were the cards that were committed to.

Why it is not next. It proves only that the deck was not changed after the
deal, and on a server somebody hosts for their own game the shuffle is the
part that would be rigged, so it answers a narrower question than the one
being asked. The reveal has a cost of its own: the shuffled order is every
folded player's cards, so revealing it per hand hands back exactly what the
history redaction exists to withhold, and revealing it at the end instead
means the history has to survive the tournament, which today it does not. And
a published hash nobody can conveniently check is theatre, so doing it
properly means shipping a verifier as well. Worth revisiting if this is ever
hosted for strangers, which is the same line 1.0.0 is drawn on.

### Done

More control over your own games. The way out is Forfeit; calling the whole
game off belongs to whoever made it as well as to whoever is holding the
clock; the host's own controls are pause, remove somebody, step the level or
put a minute on it, move a player by hand, and mute; and Your devices lists
where a Game Night account is signed in and signs any of them out, which was
the last piece and the other half of the identity bridge below. An admin
(the server's password, not the game's host) can still end any game on the
server from the table menu or the Admin page, which is for the games they
do not host.

Preferences that follow you. Mute, the chair you are shown in and the panel
tab that opens are kept against the identity rather than the browser, so a
Game Night account gets the same table on the phone and the iPad. A closed set
with a validator each, because it is a client writing into a file the server
keeps; the browser is still written first, so nothing at the table waits on
the network, and a guest is one browser, which is as far as a guest goes.

Showing a hand nobody paid to see. Nothing is shown by default and nobody is
ever made to - but when a hand ends, anybody whose cards stayed down may turn
them over for a few seconds: the winner of a pot everybody folded to, and
anybody who folded, showdown or not. Tap the card you mean, or take both. One
card is a real answer, so the state and the replay both had to learn that a
holding can be half public, which is a null where the card that stayed down
was. Two things came out of playing it: turning a card over has to hold the
table long enough for it to be looked at, or the next deal wipes the bluff you
just showed; and the wait on the decision belongs only to a pot nobody
contested, because after a showdown the cards on the table are what everyone
is reading and a fold is shown fast or not at all.

A game belongs to whoever made it. The host title is not a possession - it
passes to another player the moment a host walks back to the lobby, and busting
out is the usual reason for doing that - so a host who was eliminated used to
find their own game could only be stopped by somebody holding the server's
password. Ending it stays with the maker and with whoever holds the clock, from
the Info tab at a table and from the game's card in the lobby.

And the table saying what it is doing, which was most of the release and none
of it planned. A seat that went without a hand to explain it, an add-on
landing, an add-on being on offer at all, the way back in after a bust-out:
each was working and each was being written only into the dealer's log, which
is not the tab the side panel opens on. They are on the felt now, in the order
a table does things - the pot lands, the felt clears, the break clock comes up,
and then the question. The lesson is worth keeping: on this server, a line in
the log is not telling anybody.

Forfeit, the way out for somebody who is not coming back. Leave parks the
stack and it blinds down for the rest of the game, and only the host could
take it off the table; this does to your own seat what the host's Remove
does - the chips leave play, the place is recorded and paid if it pays, the
seat goes - while leaving you a player rather than throwing you out, so the
rail is still open. It sits under leave in the table menu and on the lobby
card of a game already walked out of, which is where a stack blinding down
with nobody behind it actually is. The decision that was open: re-entry does
not stay open to somebody who conceded, because a forfeit that could be
re-entered is a button for turning a short stack into a fresh one, and the
question the button asks would not be true.

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
[docs/MANUAL.md](./docs/MANUAL.md), for players, hosts and admins, which
opens with what each release added and where to read about it.

The Admin page lists every game the server holds, listed or not, with its
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

Signing in with a Game Night account, and the Admin page that pairs a
server with one and changes its own password. The lobby's corner menu, which
is where those live. Deployment by pulling this repository rather than
shipping an image. The join code no longer served in the public list. The
action bubble that used to outlive its street. See the CHANGELOG.

## Running the server

Not the game, and not the split below: what the person who hosts it needs.

### A real admin panel

One thing, two names: the page a player never sees is called **Admin**
everywhere it is written for a person and **admin** everywhere it is written
for a machine - `ADMIN_PASSWORD`, `adminLogin`, `adminCredential`. The admin
panel and the Admin page are the same panel, and this is it.

Today it is settings and a list: the Game Night pairing, its own password, and
every game the server holds with the one control it already had, which is
ending one. That is enough to run a game night and not enough to run a server.
It was on the "not on either path" list below, as a full admin console that
the Admin page should not grow into; that was a distinction without a
difference, and it is on the path now.

**A log is the first piece, and the reason this moved.** Asked what games this
server had run, the only answer available was to reconstruct thirteen of them
from container log lines, which a container recreate would have erased. The
same log also held nine startup crashes nobody had seen, from a permission
error reading the environment file, and the only reason anyone knows is that
somebody went looking for something else. An admin should not need a shell
on the box to learn either of those.

So: what the server has done, readable in the browser and behind the password
that is already there. Games that finished, with who played, where they came,
what they won, when it started and how long it ran, from standings the result
screen already computes. Sign-ins. Restarts, and anything that logged a
warning or an error, which is the half that would have shown the crash loop.

**What stands in the way.** The server writes structured JSON to stdout and
keeps none of it. A panel needs what it shows to be retained somewhere - a
bounded buffer in memory for the recent stuff, a file for the part that must
outlive the process - and that is most of the work. A finished tournament is
dropped ten minutes after the last hand, so the game rows have to be written
as it ends rather than read back afterwards.

**What must never be in it.** A hole card, a device token, a password, or a
join code for a game the admin is not in. An admin runs the server; that
is not the same as being allowed to see everybody's cards, and a log that a
browser can read is a log that leaks if anything else does.

Three things to decide rather than discover. How long a row is kept, since a
file that only grows is a file that eventually matters. What a game row names,
given a guest identity expires after thirty days and a uid in an old row may
point at nobody - the name as it was, probably. And whether a game that was
cancelled or written off gets a row at all, or only one that reached a winner.

Beyond the log, what an admin actually lacks is smaller than a dashboard
and worth naming before building one: seeing the games without opening each
table, and ending or unsticking one from the same place. The controls over a
running game stay in the table menu where they are, behind the same password.

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

- A full admin console **was here**, described as a thing the Admin page
  should not grow into. They were never two things: the panel is called
  Admin to a person and admin to the code, and ruling out one while keeping
  the other was ruling out nothing. It moved to "A real admin panel" above.
  What stays ruled out is a dashboard for its own sake, and the controls over
  a running game, which live in the table menu behind the same password.
