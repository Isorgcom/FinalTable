# FinalTable user manual

FinalTable is a poker tournament server you reach with a browser. Somebody
runs it (the **operator**), somebody creates a game and looks after it (the
**host**), and everybody else sits down and plays. This manual is written for
all three, in that order of how often they are the same person. Nothing needs
installing on a phone or a laptop: open the address, type a name, play.

Everything here is play chips. FinalTable keeps no money and moves none.

## What is new

The last few releases changed how a game is found, who can get in, how the
host reaches the whole room, how the blinds run, what the host can do once
the cards are out, who can watch, and whether busting is the end. The short
version, with where to read more:

| Version | What arrived                                                                                                                                                                                                          | See                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0.10.0  | Re-entry through a chosen level and an add-on at the first break, each for another buy-in into the pool, offered from the bust-out dialog and the Info tab; the felt cleared on a break with the clock in the middle. | [Creating a tournament](#creating-a-tournament), [Being eliminated](#being-eliminated), [How a tournament runs](#how-a-tournament-runs) |
| 0.9.0   | A rail link on every game for anyone who wants to watch, with the table's chat open to them; the dealer's log and the chat in separate tabs; up to forty bots.                                                        | [Watching a game](#watching-a-game), [The side panel](#the-side-panel)                                                                  |
| 0.8.0   | The host's controls at the table: pause, a level back or forward, a minute on the clock, move a player, remove a player. The bot box takes a count. Tables that should merge now do.                                  | [The host at the table](#the-host-at-the-table), [Creating a tournament](#creating-a-tournament)                                        |
| 0.7.0   | A blind structure to choose or edit when a game is made: Turbo, Standard or Deep, with antes and breaks, and the ladder in the waiting room and the Info tab.                                                         | [Creating a tournament](#creating-a-tournament), [How a tournament runs](#how-a-tournament-runs)                                        |
| 0.6.0   | The host reads and talks at every table: a strip in the Chat tab picks a table, and All announces to every table at once and over the felt.                                                                           | [The side panel](#the-side-panel), [Chat, reactions and mute](#chat-reactions-and-mute)                                                 |
| 0.5.0   | The Operator page lists every game on the server, listed or not, and can end one. A page left open across an update reloads itself.                                                                                   | [For the operator](#for-the-operator), [Updates](#updates)                                                                              |
| 0.4.0   | A game is **private by default**. Public lists it for anyone; invite-only puts a door on the link that the host works.                                                                                                | [Who can join](#who-can-join), [The door](#the-door)                                                                                    |
| 0.3.0   | Reactions: six emoji thrown at the table without typing.                                                                                                                                                              | [Reactions](#reactions)                                                                                                                 |
| 0.2.0   | Sign in with GameNight, the Operator page, the corner menu, and a join code that is no longer served to anyone who asks.                                                                                              | [Who you are](#who-you-are), [For the operator](#for-the-operator)                                                                      |

Older: table chat and a host mute, hand-for-hand at the bubble, late
registration, rejoin after a dropped connection, and a field that survives a
server restart. The full history is in [CHANGELOG.md](../CHANGELOG.md).

## The lobby

The page opens on the lobby. Top to bottom: who you are, a button to create a
tournament, a box for a code, and the list of games.

### Who you are

Type a **name** (up to 16 characters) and pick an **avatar**. That is a guest
identity, and the browser remembers it: come back tomorrow on the same device
and you are the same player, with the same seat if a game of yours is still
running. Your name is yours at each table: two people with the same name
cannot register for the same game.

If the server is paired with a GameNight site, there is a **Sign in with
GameNight** button beside the name box. Signing in there seats you here under
your GameNight username, the same player on every device you sign in from, so
a phone and a laptop are one seat rather than two. **Sign out** is in the
corner menu; it signs out this browser only.

### The corner menu

The button in the top-right corner of the lobby opens a small menu: **operator**
(only when the server has an operator password), **sign out** (only when
signed in with GameNight), and the version of FinalTable this server is
running.

### The list

Games appear in four groups:

- **Your tournaments**: anything you are registered for or have a stack in,
  whatever its state and however it is listed. The button says **Open** before
  the start and **Rejoin** after it.
- **Registering**: public games that have not started. **Join** registers you.
- **Running**: public games in play. **Join late** while late registration is
  open, otherwise the card says so.
- **Finished**: public games that ended in the last ten minutes, with the
  winner.

Only **public** games are on the list for people who are not in them. A
private or invite-only game reaches nobody's list but its own players'.

### Joining by code or link

Every game has a five-character **code**. Type it in the box and press
**Join**. The host can also send a link (the **Copy link** button in the
waiting room); opening it in a browser does the same thing, and asks for a
name first if the browser has none.

For a public or private game the code puts you straight in. For an
invite-only game it puts you at the door: see [The door](#the-door).

### Watching a game

Every game also has a **rail link**, for anyone who wants to watch without
playing. The people in the game find it beside **Copy link** in the waiting
room, as **Copy rail link**, and again in the table's Info tab. A public game
has a **Watch** button on its lobby card while it runs. The rail link is not
the code: it never seats anyone, and anyone who has it may pass it on.

Opening it asks for a name, like everything here, then puts you at the
table. You see what a busted player sees: the felt, the seats, the board,
the banner, nobody's hole cards until they are turned up, and no action bar.
The top of the page says _Watching table N_. The Info tab has a **Watching**
block listing the tables with how many are at each; pick one to move your
view. When the table you are watching empties, you are moved to the biggest
one left.

You can talk in the chat of the table you are watching, and your lines carry
a **rail** badge so the table knows who is playing and who is only talking.
The host can mute you like anyone else. Before the cards are out you read the
waiting room's chat and wait. **leave** in the menu stops watching and takes
you back to the lobby; a reload brings you back to the table, and a restart
of the server forgets the rail, so open the link again. Up to fifty people
can watch one game. If you were removed from a game, the rail link will not
let you back in either.

## Creating a tournament

Press **Create a tournament**. The form:

- **Name**: what the game is called, up to 24 characters.
- **Who can join**: see [Who can join](#who-can-join). Private is preselected.
- **Starts**: "As soon as we are 2" deals the moment a second player
  registers; the other quick picks set a time a few minutes out; or pick an
  exact date and time. A scheduled game deals itself when the time comes,
  provided two people are registered. With only one it waits, and after
  thirty minutes with nobody else it is cancelled.
- **Table size**: heads-up, 6-max or 8-max. Fields larger than one table are
  spread across as many tables as it takes.
- **Starting stack**: 1,000 to 10,000 chips.
- **Level length**: 2 to 15 minutes per blind level.
- **Blind structure**: Turbo, Standard or Deep. The line under the choice
  says how many levels, when the antes start and where the breaks fall.
  **Edit levels** opens the ladder itself: every level's small and big blind,
  ante, length in minutes and whether it is a break, with Add level and Add
  break underneath. An edit makes the structure Custom; picking a preset or
  another level length puts the preset back, edits and all.
- **Late registration**: closes at the start, or stays open through level 1,
  2, 3, 4 or 6.
- **Buy-in (play chips)**: optional. Buy-in times entries is the prize pool,
  paid out by place at the end. Zero means no pool and no payouts, just a
  winner.
- **Re-entry**: none, or through level 1, 2, 3, 4 or 6. While it is open a
  player who busts can come back with a fresh starting stack for another
  buy-in, as many times as it takes. None is a freezeout: busting is the end.
- **Add-on at the first break**: one starting stack more, once, for another
  buy-in, offered to everyone still seated during the first break. Greyed out
  when the structure has no break to offer it at.
- **Add donkey bots**: one to forty seats the server plays, so you can fill
  a table alone and watch the game move. They are demo opponents and play
  badly on purpose. Eight at 6-max is two tables and twenty-three is four,
  which is the quickest way to see the host's Move to… control and the rail.

**Create** takes you to the waiting room with the code. You are the host.

### Who can join

Chosen when the game is created; it cannot be changed after.

| Mode            | On the lobby list | Code or link           |
| --------------- | ----------------- | ---------------------- |
| **Public**      | Yes, for everyone | Joins                  |
| **Private**     | No                | Joins                  |
| **Invite-only** | No                | Asks; the host lets in |

Private is the default and is what a home game usually wants: the code or the
link is the invitation, and nobody who was not given it can find the game.
Public is for a game anyone on the server is welcome at. Invite-only is for
when the link may travel further than you meant it to: everyone who arrives
waits at the door until you let them in.

Whatever the mode, the people in a game always see it under **Your
tournaments**. And whatever the mode, the rail link lets somebody watch: see
[Watching a game](#watching-a-game).

## The waiting room

The room before the cards are out. It shows the game's name and status, the
**code** with a **Copy link** button and a **Copy rail link** button beside
it (the link for watching; see [Watching a game](#watching-a-game)), the
roster, the settings, and a chat.

**The settings line** says who can join, the table size, the starting stack,
the blind structure with how many levels, when the antes start and where the
breaks fall, the level length, late registration, re-entry, the add-on and
the buy-in. Under it,
**Blind structure** opens the whole ladder, level by level, so you can see
what the night looks like before you sit down.

**The roster** lists everyone registered, with a dot that is lit while they
are connected and a badge for GameNight sign-ins. The host sees a **mute**
control on each row; see [Chat, reactions and mute](#chat-reactions-and-mute).

**Chat** works here before there is a table to talk at. When the game starts,
the conversation moves to the table's Chat tab.

**Unregister** takes you out before the start. After the start the button is
**Leave**, and your stack stays at the table sitting out; see
[Leaving and coming back](#leaving-and-coming-back).

### The host's controls

- **Start now** deals immediately. It needs two registered players; it is
  greyed out with one.
- **Cancel tournament** ends the game before it starts and sends everyone
  registered back to the lobby.

If the host leaves before the start, or is gone for two minutes, the game
passes to whoever registered earliest among those connected. A game whose
players have all left before the start is removed.

Once the cards are out, the host's controls are in the table's Info tab; see
[The host at the table](#the-host-at-the-table).

### The door

An invite-only game's waiting room says so under the code: anyone with the
link asks to join, and the host lets them in below.

**If you are asking**: after the code or the link, the lobby shows a
"Waiting for {host} to let you in" screen. You are not in the game yet: you
are not on the roster, not in the chat, and not counted toward the start.
**Cancel request** takes you back to the lobby. If you close the tab, your
request keeps your place for a minute and then lapses. You are told if the
host turns you away, if the game is cancelled while you wait, if registration
closes first, or if someone with your name got in ahead of you.

**If you are the host**: a **Waiting to be let in** list appears between the
roster and the settings, one row per person with the same connection dot as
the roster. **Let in** registers them as if they had joined; **Turn away**
sends them back to the lobby with a note. Once the game is running, the same
list is at the top of the table's **Info** tab, and the tab lights up when
somebody new knocks, so a late arrival can be let in without leaving the
table. Up to fifty people can wait at once.

## At the table

### The screen

The **top bar** has the game's name and a line of status, then buttons:
**stats**, **replay**, **sit out**, **panel** (shows or hides the side
panel), and the **menu** (hand rankings, sound on or off, the operator's
controls when unlocked, and **leave**).

The **banner** over the felt shows the level, the blinds and the ante when
there is one, the time until the next level and how many players are left. On
a break it reads Break and the blinds play resumes at; paused, it reads
Paused and the clock stands still; on the final level there is nothing left
to count down to. When something about the moment changes, the bubble for
instance, the banner says so.

On a break the felt itself is cleared once the last hand's result has been
up for a few seconds: the cards, the pot and the button go, the seats and
their stacks stay, and the middle of the table reads **On break** with the
time to the end of it and the blinds play resumes at.

On the felt: the pot, the community cards, the seats with each player's stack
and last action, and your own two cards. A **You have …** line under the
action buttons names your hand as the board develops.

You can choose which chair you are drawn in. It is a preference for your
screen only; the table's real seats do not move.

### The host at the table

While the game runs, the host's Info tab opens with a **Host** block that
nobody else has:

- **Pause** and **Resume**. The hand in play finishes, no table deals, and
  the blind clock stands still until Resume. The banner reads Paused.
- **◀ Level** and **Level ▶**: one level back or forward, breaks included.
  The chat says "Blinds up" or "Blinds back to", and every table takes the
  new blinds at its next deal.
- **−1 min** and **+1 min**: a minute off or on the level in play. There is
  nothing to add on the final level.
- One row per seated player, with **Move to…**, listing the other tables
  with room (only a table smaller than theirs, so the tables stay level), and
  **Remove**, which asks first. A removed player's chips leave play, they
  finish in the place they hold at that moment, paid if that place pays,
  they are sent to the lobby, and they cannot come back in.

A move or a removal asked for while that table is mid-hand happens when the
hand ends. Every one of these is checked on the server; the block is only
how the host asks.

### Acting

When it is your turn the action bar appears: **fold**, **check**, **call**,
**raise** (a slider and a number box, with **3bb**, **4bb**, **5bb** and
**Pot** presets), and **all in**. You have **25 seconds** to act. **+30s**
adds thirty seconds once per hand.

If your clock runs out the seat is not played for you: it folds to a bet,
checks when that is free, and stays sitting out until you sit back in. The
blinds still post while you sit out.

### Before your turn

While others act, a row of buttons lets you decide early: **check / fold**,
**check**, **call** or **call any**. The choice fires the moment your turn
opens and clears if the action changes so that it no longer applies (a
**check** armed against a bet does nothing). **Sit out next hand** finishes
the current hand and then sits you out.

### Sitting out

**sit out** in the top bar sits you out now: the seat checks when it can and
folds to a bet, and the blinds still post. A banner across the top of the
felt says so, with **Sit back in** on it. Sitting out is what happens on its
own when your clock runs out or your connection drops.

### Reactions

Under the pre-action row is a strip of six emoji. A tap floats it over your
chair for everyone at the table to see, and then it is gone: reactions are
not written into the chat. The strip is there when it is somebody else's
turn and you are not sitting out. Three in ten seconds is the limit, and a
host mute silences reactions along with chat.

### The side panel

Docked beside the table on a wide screen, a drawer on a phone (the **panel**
button opens and closes it). Five tabs:

- **Chat**: the table's chat, with a box to type in. The tab lights up when
  somebody else says something while you are looking elsewhere. The host of
  a game with more than one table also gets a strip over the chat, **All**
  and one pill per table: pick a table to read what is said there and answer
  it, pick All to say something to every table at once. Lines from another
  table carry a small T2-style chip; the host's own lines carry a **host**
  badge wherever they land, and a watcher's a **rail** badge.
- **Log**: the dealer's narration of the hand: who posted the ante and the
  blinds, every action, each street, the showdown and who won. The strip
  over the felt repeats its last line when the panel is out of view.
- **Info**: the table (mode, players), the blinds and the ante, the level
  and the time to the next one, the whole structure with the level the clock
  is on marked, the field (tables left, which one you are at, players
  remaining, payouts), how many are watching from the rail and a **Copy
  rail link** button, and, for the host, the Host block described in
  [The host at the table](#the-host-at-the-table) and, in an invite-only
  game, whoever is waiting at the door. A watcher sees a **Watching** block
  here instead, to pick a table. When the game ends, the final standings.
- **Stats**: a leaderboard for this game (wins, hands, win rate, biggest
  pot) and your last ten hands.
- **History**: every hand you were dealt, replayable card by card and action
  by action. Only cards that were shown at the table appear; nobody's hidden
  hole cards are ever in a history but their own.

### Leaving and coming back

**leave** in the table menu takes you back to the lobby. Your stack stays in
the game, sitting out and blinding down, and the game stays under **Your
tournaments** with a **Rejoin** button that puts you back in control of it.

A dropped connection does the same without the leaving: the top of the page
says _Reconnecting…_, your seat sits out until you are back, and the page
rejoins on its own. So does a reload, and so does the same identity on
another device.

### Being eliminated

When your stack is gone you are out, with a finishing place, and a payout if
the place is paid. You can stay and watch the table you were at, or go back
to the lobby. Watching, you can still talk in that table's chat, marked
**rail**, and the Info tab's **Watching** block lets you move to another
table.

If the game allows re-entry and the window is still open, the same dialog
offers **Re-enter** beside Watch, and the Info tab keeps a **Re-enter**
block for as long as the offer stands. Taking it costs another buy-in and
seats you with a fresh starting stack at the table with the fewest players,
joining at its next deal. Your bust-out is struck from the standings, as if
it had not happened.

The host can also remove you. Then your chips leave play, you finish in the
place you held, paid if that place pays, you are sent back to the lobby with
a note saying so, and the code will not let you back into that game.

## How a tournament runs

**Blinds** follow the structure chosen at creation. Standard climbs eighteen
levels from 10/20 to 3000/6000, with antes from level 6 and a break after
levels 6 and 12. Turbo climbs faster over fifteen, with antes from level 4
and no break. Deep climbs slowly over twenty-four, with antes from level 9
and breaks after 8 and 16. Every level lasts the level length chosen at
creation unless the host edited it. The clock runs across every table at
once, and the whole ladder is in the waiting room and in the Info tab, with
the level the clock is on.

**Antes** are a big-blind ante: from the level the structure says, the player
in the big blind posts an ante equal to the big blind straight into the pot,
then the blind. It is not part of the price to call. A short stack posts the
ante first and the blind out of what is left.

**Breaks** are levels with no blinds. When one arrives, a hand in play
finishes and no table deals until it is over; the banner reads Break with the
blinds play resumes at, and the cleared felt counts the break down. A level
number counts levels of play, so a break never takes one.

**A pause** is the host's: the hand in play finishes, no table deals, and the
clock stands still until the host resumes. **A removed player** is out as if
they had busted: their stack leaves play, their finishing place is the one
they held, and their registration is gone.

**Late registration** stays open through the level chosen at creation, and
through the break after it if there is one. A late
entrant sits down with the starting stack at the table with the fewest
players, joining at that table's next deal.

**Re-entry and add-ons.** A game is a freezeout unless the host chose
otherwise when making it. With re-entry open through a level, a busted
player can buy a fresh starting stack and sit down again, the way a late
entrant does, as many times as it takes while the window is open; with the
add-on on, everyone still seated during the first break can buy one
starting stack more, once. Asked for while the table is still finishing a
hand, the add-on lands when the hand does. Each costs a buy-in, and each
goes into the prize pool. The host can remove a player who abuses it.

**Tables balance and break** as players bust: no table is ever more than one
seat different from another, and a table is broken when the field fits on one
fewer, until one table is left. A move needs both tables between hands, so
the table that is due to break, or the biggest one when the tables are more
than a seat apart, sits out one hand while the other finishes; then the move
is made and dealing carries on. No table waits otherwise.

**The bubble.** With a prize pool, one place before the money the game
announces the bubble and plays hand for hand: a table that finishes its hand
early waits for the others, so nobody can stall their way into a payout. When
the bubble bursts, everyone left is in the money.

**Payouts** come from the prize pool (buy-in times entries) by field size:

| Entrants | Places paid | Split (% of pool)                     |
| -------- | ----------- | ------------------------------------- |
| 2 to 5   | 1           | 100                                   |
| 6 to 9   | 2           | 65 / 35                               |
| 10 to 17 | 3           | 50 / 30 / 20                          |
| 18 to 29 | 4           | 40 / 27 / 20 / 13                     |
| 30 to 49 | 6           | 35 / 22 / 16 / 12 / 9 / 6             |
| 50 up    | 9           | 30 / 20 / 14 / 10 / 8 / 7 / 5 / 4 / 2 |

The field size is the number of people, so a re-entry or an add-on grows the
pool without adding a place. Whole chips only; any rounding goes to first
place.

**The end.** The last stack standing wins. The final standings appear at the
table and on the Info tab, and the game stays on the lobby's Finished list
for ten minutes.

**Nobody home.** A running game with no human connected for two minutes is
removed. A game still registering waits for its host as long as it takes,
though it is cancelled after thirty minutes past its start time with only
one entrant. A server restart loses nothing: registrations and a running
field are recorded between hands and come back exactly as they were, and
everyone's page rejoins on its own.

## Chat, reactions and mute

Chat lives in the waiting room before the start and in the table's Chat tab
after it. Messages are up to 200 characters, four in ten seconds. What was
said is replayed to anyone who reloads or rejoins, so a late arrival sees the
conversation so far.

The **host** can **mute** anyone from the waiting-room roster, and unmute the
same way. A muted player can read but not post, sees _The host has muted
you_ when they try, and cannot throw reactions either. The mute lasts for the
game.

The **host hears every table** in their game, live, whichever they are
sitting at, and can speak to one table or to all of them from the strip in
the Chat tab. A line to all tables is marked "to all tables" and flashes
over the felt for a few seconds, so a closed chat panel is not a missed
break call. A host who busts keeps the floor.

Anyone watching a table, from the rail or after busting, can talk in that
table's chat; their lines carry a **rail** badge, so a seat can tell who is
playing from who is only talking. The host's mute covers them. Reactions are
for seats only: they float over a chair, and a watcher has none.

An operator can switch chat or reactions off for the whole server; then the
box or the strip simply does not exist.

## Updates

When the server is updated, a page that was already open notices on its next
connection. In the lobby it reloads itself straight away. At a table it shows
_FinalTable was updated_ across the top and reloads once you leave the table;
tap the notice to reload sooner. Nothing is lost either way: a reload rejoins
your seat.

## For the operator

The operator is whoever knows the server's operator password. It unlocks the
**operator** item in the lobby's corner menu and the **admin** item in the
table menu. The unlock lasts as long as the browser's connection; a reload
asks again.

### The Operator page

**Games on this server** comes first: every game the server holds, listed or
not, running first, then registering, then finished. Each card shows the
status, how the game is listed (public, private or invite-only), the **join
code**, the host, how many registered players are connected, the entrants,
the tables while running, how many are waiting at the door of an invite-only
game, and when it was created or started. **End game** ends one, after a
confirmation; everyone in it is sent to the lobby with a note saying the
operator ended it. The list follows the server on its own as games come and
go; **Refresh** pulls the counts that change without that, such as a player
dropping off.

This is the one place an unlisted game and its code are shown to somebody
who is not in it. Hand codes out with care.

**Sign in with GameNight** pairs the server with a GameNight site so players
can sign in with their account there. Register the server on GameNight first
(Site Settings › Connected Apps), then enter the GameNight address and the
slug here; the signing key is fetched, nothing is pasted. **Refresh key** if
GameNight regenerates its key; **Unpair** takes the button away. The full
procedure is in [DEPLOYMENT.md](./DEPLOYMENT.md#pairing-with-gamenight).

**Operator password** changes the password. The current one is asked for
again, and the change signs out every other operator session. The first
password comes from the server's environment (`ADMIN_PASSWORD`); after a
change the new one wins, and a forgotten one is reset as described in
[DEPLOYMENT.md](./DEPLOYMENT.md#the-operator-password).

### From the table

The table menu's **admin** item takes the same password and then offers
**cancel tournament** for the game at that table. It is the same thing as End
game on the Operator page, reached without leaving the felt.

### Server settings

These live in the server's `.env` (see `.env.example`) and take effect on a
restart:

| Setting                       | Default | What it does                                                     |
| ----------------------------- | ------- | ---------------------------------------------------------------- |
| `ADMIN_PASSWORD`              | none    | The first operator password. None means no operator surface.     |
| `MAX_TOURNAMENTS`             | 8       | How many games the server holds at once.                         |
| `CHAT_ENABLED`                | true    | Chat exists at all.                                              |
| `REACTIONS_ENABLED`           | true    | The reaction strip exists at all.                                |
| `TOURNAMENT_FINISHED_TTL_MS`  | 600000  | How long a finished game stays listed (ten minutes).             |
| `TOURNAMENT_ABANDON_GRACE_MS` | 120000  | How long a running game survives with nobody connected.          |
| `HOST_TRANSFER_GRACE_MS`      | 120000  | How long a missing host keeps the game before it passes.         |
| `CHAT_RATE`, `REACTION_RATE`  | 4, 3    | Messages and reactions allowed per ten seconds.                  |
| `GAMENIGHT_URL` and friends   | none    | Seed the GameNight pairing on a first boot; the page wins after. |

## Privacy and fairness, briefly

Your hole cards are sent to your browser and nobody else's; every other seat
receives a view with them blanked, and they are shown only at a showdown or
a run-out with two or more live hands. The deck is shuffled with the
operating system's random source. Unlisted games are not on any list or in
the public API, and a game's id without its code gets "Tournament not found".
A watcher on the rail gets the same blanked view as any other seat, is never
sent the join code, and cannot sit down by the rail link. The operator, who
runs the machine, can see every game and its code, and that is the extent of
it. The details, with the code paths and the tests
behind them, are in [SECURITY.md](../SECURITY.md).
