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
means the history has to survive the tournament - which it now does, so that
half of the objection has gone. And
a published hash nobody can conveniently check is theatre, so doing it
properly means shipping a verifier as well. Worth revisiting if this is ever
hosted for strangers, which is the same line 1.0.0 is drawn on.

### Done

Mail, and the settings, on the page. Where this server sends from is set from
the Admin panel and kept in the database, with a button that tries what is on
the screen and says what the mail server said when it will not work. The
password is typed once and never shown again, and is the one recoverable
secret this server keeps - which SECURITY.md says out loud. Beside it, the
knobs that can move without a restart, each labelled with when it takes
effect.

Everybody has an account, and the admin surface is one. The name box is gone:
a player signs in with an account of this server's own or with GameNight, one
name belongs to one person server-wide, and the lobby is not drawn for anybody
who has not come through the door. The admin controls stopped being a shared
password and became a role on an account - derived once at sign-in, surviving
a reconnect, and revocable in a way a password never was. The first account on
a fresh server administers it; `ADMIN_PROMOTE` is the way back in when that is
not the answer. The Admin page gained **Users**: who plays here, and what can
be done about them.

GameNight is told how a game went. A game it made can name an address and a
secret; from then on every bust-out, every re-entry and the ending go there as
signed deliveries, written down before they are tried, retried for a day, and
given up on loudly. The places are provisional until the re-entry window
closes, because a re-entry moves everybody below it - so the finish carries
the standings that count.

GameNight can make a game here. The first piece of the split: a key made on
the Admin page, an endpoint that takes Game Night's own event, blind rows and
roster, and a game that arrives invite-only with the roster as its guest
list - the people on it walk straight in, nobody else can, and the manager
hosts. Every one of them is known to this server before they arrive, so the
seat is waiting when they sign in. Reading the game back is the other half;
the events this server would send back are next.

The first ten minutes need no shell. A fresh server is claimed from its own
sign-in card with a token from `.env`: the first account is made with no mail
and lands on the Mail tab to set some up, and nothing is restarted or read out
of a log. For the mail that never arrives afterwards, the Users page lists the
sign-ups still waiting and lets one in.

A database of its own. Everything this server keeps - accounts, identities and
the devices they are signed in on, the games in progress, the chat, the hands
it keeps and the admin log - lives in a MariaDB beside the server rather than
in JSON files next to the application. Not GameNight's: like it, not it, and
the two share nothing but the SSO bridge that was already there. Each store
keeps the shape it had, because each was already a working set in memory with
a file behind it; what changed is where the writes land. The name an account
owns is a unique key the database enforces rather than a rule only the code
knows, the two bounds on the kept games and on the log are queries, and the
token that signs a browser in is kept as a digest. The first boot imports
whatever the files held and sets them aside.

A login of its own, beside the GameNight one: an account that belongs to this
server. A name, a password, and an address confirmed by a link, which is what
makes the name theirs; a sign-up holds the name without owning it and lapses
after a day, so a mistyped address costs a retry rather than a name.
Forgetting the password sends a one-time link, and the answer on screen never
says whether a name has an account. Recovery was the question the item named
as the hard one, and email turned out to be the answer rather than the admin.

It arrived beside the guest identity it has since replaced - see above.

A server without mail can make no accounts, and says so where the buttons
would be.

Keeping them. The hands are written down as the game goes, so a restart no
longer loses what came before it, and they outlive the game itself: a
tournament is reaped ten minutes after its winner and its chat goes with it,
while its hands are kept for thirty days. **Your games** in the lobby menu
lists what somebody has played and hands them the same two files the table
does. A row a game and a table saying who was in which, which is
what lets a player be given a game the registry has long since forgotten - and
the uid is the whole authorisation, so a game somebody did not play in is
refused rather than redacted down to nothing.

Taking your hands with you. The server always recorded every hand in full and
always sent each player the part of it they were entitled to see; what was
missing was a way to keep it. The History tab writes the whole game to a file
now - a transcript to read or paste somewhere, and the same hands as JSON -
covering every hand you were dealt into rather than the ten the panel shows for
whichever table you are at, and following you across a table move the way the
leaderboard learned to. Two of the three things that were in the way went with
it: the window, and the history belonging to a table rather than to you. What
is in the file is what was already on your screen, because it is built with the
redaction the replay panel has always used - which moved into one place for the
purpose, since a second copy of that rule is a second thing to get wrong. No
uid is in it either, not even the reader's own: a file that gets pasted into a
thread has no business carrying anybody's identifier.

The admin panel. One thing with two names - **Admin** everywhere it is written
for a person, `admin` everywhere it is written for a machine - and what it
lacked was smaller than a dashboard: seeing the games without opening each
table. A card now says what a game is actually doing rather than only that it
is running: dealing, between hands, paused, on a break, holding for an empty
room, or waiting for a seat, with how many hands have been played, when the
last one was, and a pip per table saying whether it is dealing and how many
are sitting at it. It keeps itself up to date while the page is open. There
turned out to be almost nothing to unstick: every running game has a tick that
settles a field waiting on nothing, and a throw in that tick ends the game
rather than freezing it, so what looks stuck is one of a handful of legible
states and the fix was to say which. Ending one stays the only control.

The Log. What the server has done, behind the password that was already there:
a row for every game and how it ended - a winner, cancelled, or written off
after everybody left - with the entrants, the level and who finished where; a
row for every sign-in; a row for every restart; and a row for anything that
logged a warning or an error, which is the half that shows a crash loop. Kept
in a file beside the other saves and bounded by age and by count, because a
file that only grows is a file that eventually matters. Two things fell out of
building it: a warning is captured by a sink inside the logger itself, so every
one that exists or is ever added is kept without a line at the place that
raises it, and the one warning that named the original crash loop - an
unreadable environment file - now reaches the log despite happening before
there is a logger to write it. What is never in it: a hole card, a device
token, a password, or a join code.

More control over your own games. The way out is Forfeit; calling the whole
game off belongs to whoever made it as well as to whoever is holding the
clock; the host's own controls are pause, remove somebody, step the level or
put a minute on it, move a player by hand, and mute; and Your devices lists
where a Game Night account is signed in and signs any of them out, which was
the last piece and the other half of the identity bridge below. An admin
(the server's password, not the game's host) can still end any game on the
server from the table menu or the Admin page, which is for the games they
do not host.

Preferences that follow you. Mute, the chair you are shown in, the panel tab
that opens and how the cards look - the back they are dealt with, two colours
or four, and whether the face carries a large index - are kept against the
identity rather than the browser, so a Game Night account gets the same table
on the phone and the iPad. A closed set
with a validator each, because it is a client writing into a file the server
keeps; the browser is still written first, so nothing at the table waits on
the network.

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

**The admin panel is done** - see Done above. What stays ruled out is a
dashboard for its own sake. The controls over a running game live in the table
menu, offered to an administrator and to nobody else.

**Settings live on the page, not in a file.** Mail and the handful of knobs
that can move without a restart are set from the Admin panel and kept in the
database; the environment seeds a first boot and stops mattering after it.
What is left in the environment is what cannot honestly be changed while the
server runs - chat and how many hands a game keeps, where the store behind
them is not built when they are off - and the things that have to be true
before anything starts: the database, the port, the heap.

Worth remembering why this happened. Mail was four environment variables that
the stock compose file did not pass through at all, on the one setting a new
server cannot start without: no mail, no accounts, and since accounts became
the only way in, no way in. The setting that blocked a new install was the one
buried deepest. Answered twice over: the compose file passes them through
now, and a fresh server is claimed with a token before mail exists, so the
Mail tab is the first thing its administrator sees rather than the thing
standing between them and the door.

## Architecture

Decided: **two services, two containers.**

- **Game Night** - identity, invites, blinds, payouts, records.
- **Final Table** - live gameplay, and its own web UI.

They talk over an API and webhooks. Neither takes the other down.

## Core API

- ~~An endpoint to launch a game with its settings: the blind structure, player
  count, roster.~~ Done: `POST /api/games` takes Game Night's own rows and
  roster, and `GET /api/games/:id` reads the game back; see
  [docs/API.md](./docs/API.md). A level here is `{ sb, bb, ante, duration,
break }`, one to one with a row of Game Night's blind editor, and the
  endpoint takes either spelling.
- ~~It returns a unique game id.~~ Done. Every later call references it.
- Game Night to Final Table: start a game, cancel or end early, pause, and
  request a seat move - advisory only, see Seating authority below.

## Webhook events

Final Table to Game Night:

- ~~Player eliminated, with finishing place~~ Done.
- ~~Re-entry~~ Done.
- Blind level up. The server already tells every client (`tournamentLevelUp`,
  break or level, with the blinds and the time to the next); the webhook is
  the same event sent outward.
- ~~Tournament complete, with final standings~~ Done, and a cancellation with
  the standings so far.

What shipped: a game made over the API names an address and a secret, and
the server sends it every bust-out (with the place, provisional until late
registration and re-entry have closed), every re-entry, and the ending. Each
is signed, written to an outbox before the first attempt, retried on a
backoff for about a day, in order per game, and given up on loudly in the
admin Log. See [docs/API.md](./docs/API.md).

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

The name reservation is done: one name is one person across both providers,
and a Game Night display name that is already taken here is worn with a number
after it rather than refused at the door. Still to do: a reject-list so
somebody can be signed out of every device mid-game from the Game Night side -
the server can do it now, but only from its own Users page.

## Seating authority

- Game Night owns seating before the tournament starts.
- Once it is live, Final Table's tournament director owns it - balancing and
  collapsing tables.
- A manual move from Game Night is a request the director may override.

## Standalone mode

Final Table must run without Game Night existing at all.

- An account of its own: a name, a password, and an address confirmed by a
  link, plus join-by-URL links. Done, and the whole of what a server with no
  Game Night needs. It used to be a guest username and a session token, which
  was simpler and meant anybody could be anybody.
- Mixed tables - regulars alongside walk-ins. Done: every identity carries a
  `provider`, the roster badges a Game Night player, and both kinds of account
  sit at the same table. The seam that used to be here - somebody taking a
  member's name - is closed: one name is one person, server-wide.
- There is no guest to upgrade any more. Somebody who plays here with an
  account of this server's own and later joins the Game Night keeps both, and
  they are two people as far as this server is concerned.

## Game Night side

Add a third event type alongside invite-only and physical poker: an **online
event**. It is the only type that calls the Final Table API, and it
auto-invites and seats the roster.

## Build order

Suggested, for the split:

1. ~~The game-creation endpoint and the game id~~ (done)
2. ~~The elimination and tournament-complete webhooks~~ (done, with re-entry)
3. ~~The JWT bridge and the redirect flow~~ (done)
4. The blind-level event
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
  the other was ruling out nothing. It moved onto the path, and it is done -
  see Done. What stays ruled out is a dashboard for its own sake. The controls
  over a running game live in the table menu, offered to an administrator and
  to nobody else.
