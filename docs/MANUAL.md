# FinalTable user manual

FinalTable is a poker tournament server you reach with a browser. Somebody
runs it (the **admin**), somebody creates a game and looks after it (the
**host**), and everybody else sits down and plays. This manual is written for
all three, in that order of how often they are the same person. Nothing needs
installing on a phone or a laptop: open the address, sign in, play.

Everything here is play chips. FinalTable keeps no money and moves none.

## What is new

The releases since 0.12 changed who you are here, what the table looks like,
which games it deals, and what a paired GameNight can do with it. The short
version, newest first, with where to read more:

| Version       | What arrived                                                                                                                                                                                                               | See                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0.32.0        | **HORSE**: five games in turn, one a level - Hold'em, Omaha Hi-Lo, Razz, Seven-Card Stud, Stud Hi-Lo - with the banner, the log and the structure ladder naming the round.                                                 | [The screen](#the-screen), [How a tournament runs](#how-a-tournament-runs)               |
| 0.31.0        | **Razz, Omaha Hi-Lo and Stud Hi-Lo**: the low hand and the split pot. The game is picked from a drop-down grouped by family.                                                                                               | [The screen](#the-screen), [Creating a tournament](#creating-a-tournament)               |
| 0.30.0        | **Five-Card Draw and Crazy Pineapple**: a draw round, with your own cards as the control.                                                                                                                                  | [Acting](#acting)                                                                        |
| 0.29.0        | **Omaha and Seven-Card Stud**, and the betting - no-limit, pot-limit or fixed-limit - chosen per game. A stud table seats seven. No-limit lost the four-raise cap that was never its rule.                                 | [Creating a tournament](#creating-a-tournament), [Acting](#acting)                       |
| 0.28.0        | An invite-only game can let people in **by the link alone**: a name is enough, no account and no host approval.                                                                                                            | [Who can join](#who-can-join), [The door](#the-door)                                     |
| 0.27.0        | Your **GameNight photo is your face** at the table. A seat is a round portrait on a plate with the cards tucked behind it, the turn clock is a ring round the face, and a card is one big index.                           | [Who you are](#who-you-are), [The screen](#the-screen)                                   |
| 0.26.0        | A paired GameNight can **run the game it made** - start, pause, resume, cancel, move or take out a player - and sign a player out everywhere. Its key drives only the games made over the API (0.26.1).                    | [The Admin page](#the-admin-page)                                                        |
| 0.23.0-0.25.0 | GameNight can **make a game here** with a guest list, and is **told how it goes**: every bust-out, re-entry, level, break, pause and the ending.                                                                           | [The door](#the-door), [The Admin page](#the-admin-page)                                 |
| 0.22.0        | **Claim a fresh server** from the sign-in card with a token; **let in** a sign-up whose mail never came; sign in without mail.                                                                                             | [Who you are](#who-you-are), [For the admin](#for-the-admin)                             |
| 0.21.0        | **Everybody has an account.** The admin is an account too, not a password; the Admin page gained **Mail**, **Server** and **Users**; the server keeps everything in a database of its own.                                 | [Who you are](#who-you-are), [For the admin](#for-the-admin)                             |
| 0.20.0        | Your hands keep for thirty days: **your games** in the corner menu, with the same downloads the History tab has.                                                                                                           | [Your games](#your-games)                                                                |
| 0.19.0        | **Transcript (.txt)** and **Data (.json)** under History write the whole game to a file.                                                                                                                                   | [The side panel](#the-side-panel)                                                        |
| 0.17.0-0.18.1 | The Admin page's **Log** holds what the server has done; its **Games** list says what each game is doing; the Stats leaderboard covers the whole field; a heads-up table short of an opponent says **Waiting for a seat**. | [The Admin page](#the-admin-page), [The side panel](#the-side-panel)                     |
| 0.16.0        | The pot floats to the chair that won it; a **door** and a **speaker** in the felt's corners; **cards** in the menu - the back, two or four colours, a large index.                                                         | [When a pot is pushed](#when-a-pot-is-pushed), [How the cards look](#how-the-cards-look) |
| 0.15.0        | The Operator page became the **Admin** page, behind a strip of tabs.                                                                                                                                                       | [The Admin page](#the-admin-page)                                                        |
| 0.14.0        | **Your devices**; mute, your chair and the panel tab follow you between devices.                                                                                                                                           | [Who you are](#who-you-are)                                                              |
| 0.13.0        | A table with nobody at it **holds** instead of ending; the phone's action bar became one row.                                                                                                                              | [Leaving and coming back](#leaving-and-coming-back), [Acting](#acting)                   |
| 0.12.0        | **Showing a hand** nobody paid to see; fold dimmed while checking is free.                                                                                                                                                 | [Showing a hand](#showing-a-hand)                                                        |

Older: forfeit, and ending a game from the lobby (0.11.0); re-entry and the
add-on (0.10.0); the rail (0.9.0); the host's controls at the table (0.8.0);
blind structures (0.7.0); the host talking to every table (0.6.0); the Admin
page (0.5.0); private by default (0.4.0); reactions (0.3.0); sign in with
GameNight (0.2.0); and before that table chat and a host mute, hand-for-hand
at the bubble, late registration, rejoin after a dropped connection, and a
field that survives a server restart. The full history is in
[CHANGELOG.md](../CHANGELOG.md).

## The lobby

The page opens on the sign-in card. Once you are in, the card shrinks to one
line - _Playing as_ your face and name, or _Signed in with GameNight as_ -
and under it are **Create a tournament** and the box for a code, side by
side, then the list of games.

### Who you are

Everybody who plays here has an account. There are two kinds, and the sign-in
screen is the first thing you see.

An **account on this server** is a name (up to 16 characters) and a password.
Making one takes an email address: press **Create an account**, choose a
password, then give an address and an avatar and press **Send the link**, and
open the link that arrives. That link is what makes the name yours - until you
open it the name is held for you and owned by nobody, and the hold lapses
after a day, so a mistyped address costs a retry rather than a name. After
that, **Sign in** from any browser. **Forgot your password?** sends a link
that works once and lasts an hour, and **change password** in the corner menu
changes it without signing any device out.

If the server is paired with a GameNight site, there is a **Sign in with
GameNight** button, and no second account to make: signing in there seats you
here under your GameNight username, with your GameNight profile photo as your
face at the table, in the waiting room and beside your name in the lobby. The
photo is not copied here - your browser fetches it from GameNight - so
changing it there changes it here at your next sign-in, and a member with no
photo keeps the emoji they picked. (This needs GameNight 1.3.0 or newer at the
other end.) For a GameNight account **sign out** is in the corner menu; it
signs out this browser only, ending that session here as well as clearing the
browser. An account on this server signs a device out from **Your devices**.

Either way you are the same player on every device you sign in from, so a
phone and a laptop are one seat rather than two. A name belongs to one person
on the whole server - the same name in different letters is the same name - so
nobody else can sit down under it. If your GameNight name is one somebody here
already has, you play as that name with a number after it, and the lobby says
so when you arrive. A suspended account is told so at the door.

A server that has no way to send mail cannot make new accounts or reset a
password, and says so where the buttons would be; accounts that already exist
still sign in, and so does GameNight if the server is paired. A server with
neither has no way to make a first account, which is something for whoever
runs it to fix. A server nobody runs yet says that instead - _This server has
no administrator yet_ - and, when whoever set it up gave it a claim token,
offers **Claim this server**: a name, password, address and avatar plus the
token make the first account, which runs the server and lands on the Admin
page's Mail tab.

There is one more way in, for one case: an invite-only game whose host ticked
_Guests can join freely with the link_. Its link opens on a name box rather
than the sign-in card, and the name is enough - see
[Joining by code or link](#joining-by-code-or-link).

**Your devices**, in the corner menu, lists where you are signed in: each one
named as far as the browser will say, with when it was last here and _This
device_ on the one you are reading. **Sign out** beside any row ends that
session, wherever the device is; it goes back to the sign-in card the moment
it hears, and a stack it left in a game stays exactly where it is for whoever
signs in there next. **Sign out here** on your own row asks first, since
nothing on that screen can undo it.

Six settings follow you rather than the browser: whether the table is silent,
which chair you are shown in, which side panel tab opens, and the three card
settings under [How the cards look](#how-the-cards-look). They are kept
against who you are, so an account that picks a chair on the phone finds the
same chair on the iPad. Changing one takes effect at once; the server is told
afterwards, so nothing at the table waits on it.

### The corner menu

The button in the top-right corner of the lobby opens a small menu: **admin**
(only for an administrator), **your games** (see [Your games](#your-games)),
**change password** (accounts on this server), **your devices**, **sign out**
(GameNight accounts), and the version of FinalTable this server is running.

### The list

Games appear in four groups:

- **Your tournaments**: anything you are registered for or have a stack in,
  whatever its state and however it is listed. The button says **Open** before
  the start and **Rejoin** after it, and the card also carries **Forfeit**,
  **Re-enter**, **Add-on** or **End** when one of those applies to you. A
  private or invite-only game is tagged as such here.
- **Registering**: public games that have not started. **Join** registers you.
- **Running**: public games in play. **Join late** while late registration is
  open; otherwise the button reads **Late reg closed**. **Watch** opens the
  rail.
- **Finished**: public games that ended in the last ten minutes, _Won by_
  whoever won.

The line under a game's name carries what matters before joining: the host,
how many are in, the game and its betting, the table size, the starting stack,
the structure, the level length, late registration (or _no late reg_),
re-entry and the add-on when the game has them, and the buy-in. The status
line under that says _Starts in_ so much, or the level, how many are left, and
whether the game is paused or holding.

Only **public** games are on the list for people who are not in them. A
private or invite-only game reaches nobody's list but its own players' - and a
game with a guest list reaches the lists of the people on it.

### Joining by code or link

Every game has a five-character **code**. Type it in the box and press
**Join**. The host can also send a link (the **Copy link** button in the
waiting room); opening it in a browser does the same thing. A browser that is
not signed in is asked to sign in first - _Sign in to join this game_ - and
the code is kept through the sign-in, the GameNight round trip or the email
link, so you land in the game at the end of it.

The exception is an invite-only game whose host ticked _Guests can join freely
with the link_. Its link opens on a screen with the game's name, a line about
it (how many are in, when it starts, the game and the blinds), a **Your name**
box and **Join game**. The name is all it takes: it makes you a player on this
server - the same person on that browser from then on, with that name held
for you - and seats you. A name somebody already has is refused, and so is a
game whose registration has closed.

For a public or private game the code puts you straight in. For an
invite-only game without that box ticked it puts you at the door: see
[The door](#the-door).

### Watching a game

Every game also has a **rail link**, for anyone who wants to watch without
playing. The people in the game find it beside **Copy link** in the waiting
room, as **Copy rail link**, and again in the table's Info tab. A public game
has a **Watch** button on its lobby card while it runs. The rail link is not
the code: it never seats anyone, and anyone who has it may pass it on.

Opening it asks you to sign in, like everything here, then puts you in the
waiting room if the game has not started - your copy of it shows the rail code
rather than the join code, says _Watching_ in its status, and offers **Stop
watching** where a player has Leave - or at the table once it has. You see
what a busted player sees: the felt, the seats, the board, the banner,
nobody's hole cards until they are turned up, and no action bar. The top of
the page says _Watching table N_. The Info tab has a **Watching** block listing
the tables with how many are at each; pick one to move your view. When the
table you are watching empties, you are moved to the biggest one left.

You can read the waiting room's chat and talk in the chat of the table you are
watching once the cards are out; your lines carry a **rail** badge so the
table knows who is playing and who is only talking, and the host can mute you
like anyone else. **leave** in the menu stops watching and takes you back to
the lobby; a reload brings you back to the table, and a restart of the server
forgets the rail, so open the link again. Up to fifty people can watch one
game. If you were removed from a game, the rail link will not let you back in
either.

## Creating a tournament

Press **Create a tournament**. The form:

- **Name**: what the game is called, up to 24 characters. _Game Night_ until
  you type one.
- **Who can join**: see [Who can join](#who-can-join). Private is preselected.
  Invite-only adds a box, **Guests can join freely with the link**.
- **Game**: a drop-down grouped by family - flop games (Texas Hold'em, Omaha,
  Omaha Hi-Lo, Crazy Pineapple), stud games (Seven-Card Stud, Stud Hi-Lo,
  Razz), draw games (Five-Card Draw) and mixed games (HORSE) - with a line
  under it saying what the game is. [The screen](#the-screen) describes each.
- **Betting**: **No-limit**, **Pot-limit** or **Fixed-limit**. Picking a game
  sets this to the betting it is usually played at - Omaha and Omaha Hi-Lo
  pot-limit, the stud games and HORSE fixed-limit, the rest no-limit - and you
  can pick another.
- **Starts**: the form opens ten minutes out. **As soon as we are 2** deals
  the moment there are two entrants (bots count); **+5**, **+15**, **+30** and
  **+60** set a time that far ahead; or pick an exact date and time. A
  scheduled game deals itself when the time comes, provided two are in. With
  only one it waits - _Waiting for one more entrant_ - and after thirty
  minutes with nobody else it is cancelled.
- **Table size**: heads-up, 6-max, 7-max or 8-max (the default). A stud game
  or HORSE holds the table to seven, so 8-max is greyed out for those. Fields
  larger than one table are spread across as many tables as it takes. At
  heads-up an odd number left in cannot be seated in pairs, so one player waits
  for a seat until a match somewhere else ends; their table says _Waiting for
  a seat_ while they do.
- **Starting stack**: 1,000, 2,000, 5,000 (the default) or 10,000 chips.
- **Level length**: 2, 3, 5 (the default), 10 or 15 minutes per blind level.
- **Blind structure**: Turbo, Standard or Deep. The line under the choice says
  what the preset is for, how many levels, when the antes start and where the
  breaks fall, and what level one turns into in the game you picked - _Level
  1: blinds 25/50 · bets 50/100_, or for a stud game the ante, the bring-in and
  the bets, _every hand antes_. **Edit levels** opens the ladder itself: every
  level's small and big blind, ante, length in minutes (any length, in
  half-minute steps) and whether it is a break, with a × to delete a row and
  **Add level** and **Add break** underneath; up to sixty rows. An edit makes
  the structure _Custom, edited from_ whichever preset; picking a preset,
  the one already chosen included, or another level length puts the preset
  back, edits and all.
- **Late registration**: **Closes at start**, or stays open through level 1,
  2, 3 (the default), 4 or 6.
- **Buy-in (play chips)**: optional, up to 10,000. Buy-in times entries is the
  prize pool, paid out by place at the end. Zero means no pool and no payouts,
  just a winner.
- **Re-entry**: none, or through level 1, 2, 3, 4 or 6. While it is open a
  player who busts can come back with a fresh starting stack for another
  buy-in, as many times as it takes. None is a freezeout: busting is the end.
- **Add-on at the first break**: one starting stack more, once, for another
  buy-in, offered to everyone still seated during the first break. Greyed out
  when the structure has no break to offer it at.
- **Add donkey bots**: seats the server plays - one to eight, twelve, sixteen,
  twenty-four, thirty-two or forty, five to begin with - so you can fill a
  table alone and watch the game move. They are demo opponents and call far
  too much. Twenty-four and you at 6-max is five tables, which is the quickest
  way to see the host's Move to… control and the rail.

**Create** takes you to the waiting room with the code. You are the host.

### Who can join

Chosen when the game is created; it cannot be changed after.

| Mode                         | On the lobby list | Code or link                        |
| ---------------------------- | ----------------- | ----------------------------------- |
| **Public**                   | Yes, for everyone | Joins                               |
| **Private**                  | No                | Joins                               |
| **Invite-only**              | No                | Asks; the host lets in              |
| **Invite-only, guests free** | No                | Joins, with a name if not signed in |
| **Guest list**               | For the guests    | Listed people join; nobody else can |

Private is the default and is what a home game usually wants: the code or the
link is the invitation, and nobody who was not given it can find the game.
Public is for a game anyone on the server is welcome at. Invite-only is for
when the link may travel further than you meant it to: everyone who arrives
waits at the door until you let them in - unless you tick **Guests can join
freely with the link**, which turns the link into the invitation itself:
whoever opens it is in, signed in or by typing a name, with nothing for you to
approve. A **guest list** is not on the form: it is what a game made by
GameNight has, the roster it was made with.

Whatever the mode, the people in a game always see it under **Your
tournaments**. And whatever the mode, the rail link lets somebody watch: see
[Watching a game](#watching-a-game).

## The waiting room

The room before the cards are out. It shows the game's name and status, the
**code** with a **Copy link** button and a **Copy rail link** button beside
it (the link for watching; see [Watching a game](#watching-a-game)), the
roster, the settings, and a chat.

**The settings line** says who can join, the game and its betting, the table
size, the starting stack, the blind structure with how many levels, when the
antes start and where the breaks fall, the level length, late registration,
re-entry, the add-on, and the buy-in with the prize pool it makes and what
each place pays. Under it, **Blind structure** opens the whole ladder, level
by level, so you can see what the night looks like before you sit down; in
HORSE each level names the game it plays.

**The roster** lists everyone registered, with a dot that is lit while they
are connected, their face, and badges for the host, a bot, a GameNight sign-in
and, once they are out, their finishing place. The host sees a **Mute**
control on every other person's row; see
[Chat, reactions and mute](#chat-reactions-and-mute).

**Chat** works here before there is a table to talk at. When the game starts,
the conversation moves to the table's Chat tab.

**Unregister** takes you out before the start. After the start the buttons
are **Go to table** and **Leave**; leaving keeps your stack at the table
sitting out, see [Leaving and coming back](#leaving-and-coming-back).

### The host's controls

- **Start now** deals immediately. It needs two entrants, bots included; it is
  greyed out with one.
- **Cancel tournament** ends the game before it starts and sends everyone
  registered back to the lobby. It asks first.

If the host leaves before the start, or is gone for two minutes, the game
passes to whoever registered earliest among those connected. A game whose
players have all left before the start is removed.

Once the cards are out, the host's controls are in the table's Info tab; see
[The host at the table](#the-host-at-the-table).

### The door

An invite-only game's waiting room tells its host so under the code: anyone
with the link asks to join, and the host lets them in below. With **Guests can
join freely with the link** ticked there is no door at all - everyone who
opens the link is in - and nobody waits.

A game GameNight made has a **guest list** instead - the roster it was made
with - and the door works differently: everybody on the list walks straight
in, by the link or from their own lobby list, where the game shows with
**Join** (or **Join late** while late registration is open); anybody else who
presents the code is told they are not on the guest list. Nobody asks and
nobody is let in by hand, so the host's waiting room says there is a guest
list rather than offering the door.

**If you are asking**: after the code or the link, the lobby shows a
_Waiting for {host} to let you in_ screen: the game is invite-only, the host
can see you asking and will let you in, or not, and you can leave the door at
any time. You are not in the game yet: you are not on the roster, not in the
chat, and not counted toward the start. **Cancel request** takes you back to
the lobby. If you close the tab, your request keeps your place for a minute
and then lapses. You are told if the host turns you away, if the game is
cancelled while you wait, if registration closes first, or if someone with
your name got in ahead of you; if the host changes while you wait, the name on
the screen changes with them.

**If you are the host**: a **Waiting to be let in** list appears between the
roster and the settings, one row per person with their face and the same
connection dot as the roster. **Let in** registers them as if they had joined;
**Turn away** sends them back to the lobby with a note. Once the game is
running, the same list is in the table's **Info** tab, under the Host block,
and the tab lights up when somebody new knocks, so a late arrival can be let
in without leaving the table. Up to fifty people can wait at once.

## At the table

### The screen

The **top bar** carries the FinalTable title with a **Tournament** badge and
a line of status - the hand number, the street by the name the game gives it
(_Flop_, _Third street_, _Before the draw_), your chips, and _sitting out_
when you are; while you wait it says what for, and while you watch, which
table. Then the buttons: **stats** and **replay** (each opens a side panel
tab), **sit out**, **panel** (shows or hides the side panel), and the
**menu** (**hands**, the ranking of poker hands, with the low hands added at a
table that scores one; **cards**, see
[How the cards look](#how-the-cards-look); **mute sound** or **unmute
sound**; **cancel tournament**, for an administrator only; **leave**; and
**forfeit**).

The felt's two top corners hold the controls you reach for without thinking,
and neither carries a word. On the left, a **door**: it takes you back to the
lobby, the same as **leave** in the menu. On the right, a **speaker**: press it
to turn the sound off and on. The speaker is drawn with waves while there is
sound and crossed out when there is not, so it says which it is rather than
what pressing it will do; **mute sound** in the menu is the same switch.

The **banner** over the felt shows the level and what it posts - the blinds
and the ante when there is one, or for a stud game the ante, the bring-in and
the two bets - the time until the next level and how many are left of how
many started. On a break it reads Break and what play resumes at; paused, it
reads Paused and the clock stands still; on the final level there is nothing
left to count down to; at the bubble it says so, with how many are paid and
_hand for hand_ when that applies; short of an opponent or while the tables
are being moved it says _Waiting_ and what for. In HORSE it names the game
the level plays beside its stakes.

On a break the felt itself is cleared once the last hand's result has been
up for a few seconds: the cards, the pot and the button go, the seats and
their stacks stay, and the middle of the table reads **On break** with the
time to the end of it and what play resumes at. A table holding for an empty
room reads **Holding**, and one waiting for a seat says so.

On the felt: the pot, the community cards in the games that have them, the
seats, and your own cards. A **seat** is a round portrait - your GameNight
photo, or the emoji you picked - hanging off the left end of a plate that
carries the name over the stack, with that seat's cards tucked half behind
it; your own cards are the size of the board's. The small and big blind, or
the stud bring-in, sit as marks on the face, and the dealer button hangs off
the plate. What was put in this hand shows on the plate as _in 40_, an action
shows in a bubble over the seat for a moment (_call 40_, _raise 120_, _ALL
IN_), a line of chat floats over its speaker's chair, and a seat that is
sitting out, disconnected, all in or folded says so where its stack was. The
turn clock is a ring round the portrait of whoever is to act, draining
clockwise: green, amber under fifteen seconds, red under nine, with one
warning sound on your own seat. A **card** is one big index - the rank with
its suit under it - and its mirror in the far corner, with nothing in the
middle.

A **You have …** line names your hand as it develops: in the action bar, with
the cards that make it, when it is your turn, and as a caption on your own
plate the rest of the time. In Omaha it is the hand that exactly two of your
four make; in stud, what your cards have made so far; in a Hi-Lo game it says
the low beside the high.

Which game a table plays is the host's pick from the create form's drop-down,
grouped by family: **Hold'em**, **Omaha** (four cards, and exactly two of them
play with three from the board), **Omaha Hi-Lo**, **Crazy Pineapple** (Hold'em
with three cards, one of which you must throw away after the flop's betting),
**Seven-Card Stud** (seven cards each, no board; everyone antes and the low
card showing brings in; the third, fourth, fifth and sixth cards are dealt face
up for the whole table to see, and the strongest cards showing open each
street), **Stud Hi-Lo**, **Razz**, **Five-Card Draw** (five cards each, no
board; a bet, then the draw - throw away up to five and get as many back, or
stand pat - then a bet) and **HORSE**, which plays five of these in turn. A
stud table seats seven, and so does a HORSE table.

**Razz** is Seven-Card Stud played for low: the lowest hand wins, the ace is
the lowest card, and straights and flushes count for nothing, so 5-4-3-2-A -
the wheel - is the best hand there is. The _highest_ card showing brings in,
and the best low showing opens each later street. The Hi-Lo games - **Omaha
Hi-Lo** and **Stud Hi-Lo** - score every hand twice and halve the pot: half to
the best high hand, half to the best low, where a low is five different cards
all eight or lower, aces low (_eight-or-better_). When no hand makes a low,
the high takes the whole pot and the log says so; when one hand is best both
ways it _wins both ways_. The odd chip goes to the high. Your readout says
both - _You have Three Kings · Seven-four low_ - and the replay heads the
winners _High and low_. Beside the game is the betting:
**no-limit**, **pot-limit** (a raise is at most the pot) or **fixed-limit**
(every bet is the level's bet, doubled from the turn, from fifth street, or
after the draw, and a street closes after four raises - except heads-up). Each
game comes up at the limit it is usually played at - Hold'em no-limit, Omaha
pot-limit, Stud fixed-limit - and the host can pick another. The blind rows
are the same for every game; a stud level reads its small blind as the
bring-in, half of that as the ante, and its big blind and twice it as the two
bets, and the form says what level one turns into.

**HORSE** is five of these in turn, one a level: Hold'em, then Omaha Hi-Lo,
Razz, Seven-Card Stud and Stud Hi-Lo, and round again from level six. A hand
already running when the level turns finishes as the game it was dealt; the
next deal is the new one. The banner names the game the level plays beside
its stakes, the log says which game the level went up into ("Bets up: Razz ·
ante 5 · bring-in 10 · bets 20/40 (level 3)"), the structure ladder in the
waiting room and the Info tab says which game each level is, and the host's
Level ▶ turns the game as it turns the blinds. It comes up at fixed-limit,
as HORSE is played, and its tables seat seven.

You can choose which chair you are drawn in: right-click a chair (press and
hold on a touch screen) for **show me here**, **pick a chair** or **back to my
usual chair**. It is a preference for your screen only; the table's real seats
do not move.

### The host at the table

While the game runs, the host's Info tab opens with a **Host** block that
nobody else has:

- **Pause** and **Resume**. The hand in play finishes, no table deals, and
  the blind clock stands still until Resume. The banner reads Paused. While
  the table is holding because everybody with chips has stepped away the
  button reads **Waiting for players** and does nothing: that hold is not
  yours to lift, and it lifts itself when somebody is back.
- **◀ Level** and **Level ▶**: one level back or forward, breaks included.
  The dealer's log says _Blinds up_ (or _Bets up_ in a stud game) and _back
  to_ for a step backwards, every table takes the new blinds at its next deal,
  and in HORSE the game turns with the level.
- **−1 min** and **+1 min**: a minute off or on the level in play. There is
  nothing to add on the final level.
- One row per seated player, with **Move to…**, listing the other tables with
  a free seat (the server refuses a move that would leave the tables more than
  a seat apart, and says so), and **Remove**, which asks first. A removed
  player's chips leave play, they finish in the place they hold at that
  moment, paid if that place pays, they are sent to the lobby, and they cannot
  come back in.
- **End tournament**, set apart at the foot of the block. The game stops
  where it is, with no winner and no payouts, and everyone still in it is
  sent back to the lobby with a note saying the host called it off. It asks
  first and cannot be undone. An administrator's own way to end a game is
  **cancel tournament** in the table menu, for games they do not host.

The host is whoever is running the clock, and that is not always the person
who made the game: the title passes to another player when a host drops out
or walks back to the lobby. Ending the game stays with both. Whoever made it
keeps an **End** button on its card under **Your tournaments**, so a host who
busts out and goes back to the lobby can still call off their own game, and
the Info tab shows them that one control under **Your game** if they come
back to watch.

A move or a removal asked for while that table is mid-hand happens when the
hand ends. Every one of these is checked on the server; the block is only
how the host asks.

### Acting

When it is your turn the action bar appears: **fold**, **check** or **call**
(the amount on it - _call 40_, or _all-in call_ when it takes your whole
stack), **raise** (a slider and a number box, with presets: **3bb**, **4bb**,
**5bb** and **Pot** before the flop, a third, a half and three quarters of the
pot and **Pot** after it; a preset that would be your whole stack reads **All
in**, and one under the minimum raise is greyed out), and **all in**. The
keys **F**, **K**, **C**, **R** and **A** do the same. **fold** is dimmed
while checking is free, because giving the hand up when it costs nothing to
stay is never what anybody means to do; it comes back the moment there is a
bet to fold to. A raise is not offered when nobody is left to answer it or
your stack is under the minimum. Under pot-limit the slider stops at the pot,
and **all in** reads **pot** when your stack is bigger than that: the most you
may raise is a pot raise. Under fixed-limit there is nothing to size, so the
one button reads the bet - **bet 20**, **raise to 40** - and there is no
slider and no presets.

On a draw - Five-Card Draw's, or Crazy Pineapple's discard after the flop -
there is nothing to bet either. The bar says what is wanted (_Tap up to 5
cards to throw away_), and your own cards are the control: tap one to pick it
to throw away, and it lifts; tap it again to keep it. The one button says what
you have picked - **stand pat**, **draw 2**, or in Pineapple **discard** once
you have picked the one card it wants - and **D** sends it. Every seat still
in the hand draws in turn from the dealer's left, all-in seats included, and
nobody's cards are turned up until the last has chosen. The bubble over a seat
says **draws 2**, **stands pat** or **discards**, and the log says the same. A
clock that runs out stands pat, or throws away only what the street insists
on, and a seat sitting out does the same. When the deck runs dry - eight seats
drawing five will do it - the discards are shuffled back in, and the log says
so. The replay keeps each hand as it stood after the draw; what went before it
survives as the _draws 2_ lines.

On a phone held upright there is room for three decisions and no more, so the
bar is **fold**, **check** or **call**, and **raise**, each the width of a
thumb. Raise is two taps there: the first opens the presets, the slider and the
amount, and the second, which says what it will cost, sends it; **all in** is
in there too. **back** leaves the hand as it was. Everything else stays one
tap, and under fixed-limit the raise is one tap as well.

You have **25 seconds** to act. **+30s**, beside your stack while a clock is
running, adds thirty seconds once per hand.

If your clock runs out the seat is not played for you: it folds to a bet,
checks when that is free, and on a draw stands pat. Run out twice in a row
and it sits you out until you sit back in; acting yourself starts the count
again. The blinds still post while you sit out.

### When a pot is pushed

The chips fly from the middle of the table to the chair that won them, and the
amount floats up over that chair as they arrive - **+3240** - then fades. It
is the figure that was sitting on the pot a moment earlier, so you can follow
one number across the felt. A split pot floats each player their own share
rather than the whole pot, and a pot won by everybody folding shows it the same
as one won at showdown.

### Showing a hand

When a hand ends, anybody whose cards stayed down may turn them over for the
few seconds before the next deal. That is the winner of a pot everybody folded
to, and anybody who folded, whether the hand went to a showdown or not: showing
what you laid down is as much a part of the game as showing what won.

Your own cards go gold when you are being asked - _Show?_ in the row beside
sit out. **Tap one** to turn just that one over, tap another as well, or use
**all**; **no** puts it away. A stud card that was dealt face up is already
everybody's and is not on offer, and a seat that is sitting out or
disconnected is not asked.

A card you turn over goes where a showdown's cards go: face up on the felt for
everyone, named in the dealer's log, and in the replay afterwards. A card you
keep down stays as unseen as a fold. Doing nothing is a complete answer.

The table waits five seconds after a pot nobody contested, because there is
nothing else on the felt to be looking at. After a showdown it does not — the
cards on the table are what everyone is reading, so a fold is shown quickly or
not at all. Either way, once you have turned something over the table holds
long enough for it to be seen.

### Before your turn

While others act, a row of buttons lets you decide early: **check / fold**
(just **fold** once there is a bet), **check** while that is free, **call**
with the amount once there is a bet, or **call any**. The choice fires the
moment your turn opens and clears if the action changes so that it no longer
applies (a **check** or a **call** armed before a raise does nothing). **Sit
out next hand** finishes the current hand and then sits you out; it reads
_sitting out next hand_ while it is armed. The row is put away during a draw.

### Sitting out

**sit out** in the top bar sits you out now: the seat checks when it can and
folds to a bet, and the blinds still post. A banner where the action bar was
says _You are sitting out. Your blinds still post_, with **Sit back in** on
it. Sitting out is also what happens on its own when your clock runs out twice
in a row or your connection drops.

### Reactions

Under the pre-action row is a strip of six emoji - applause, laughter,
surprise, a wince, an eye-roll and fire. A tap floats it over your chair for
everyone at the table to see, and then it is gone: reactions are not written
into the chat. The strip is there when it is somebody else's turn and you are
not sitting out. Three in ten seconds is the limit, and a host mute silences
reactions along with chat.

### The side panel

Docked beside the table on a wide screen, a drawer on a phone (the **panel**
button opens and closes it, and shows a dot when something new has arrived
while it was closed). Five tabs:

- **Chat**: the table's chat, with a box to type in. The tab lights up when
  somebody else says something while you are looking elsewhere. The host of
  a game with more than one table also gets a strip over the chat, **All**
  and one pill per table: pick a table to read what is said there and answer
  it, pick All to say something to every table at once. Lines from another
  table carry a small T2-style chip; the host's own lines carry a **host**
  badge wherever they land, and a watcher's a **rail** badge.
- **Log**: the dealer's narration of the hand: who posted the ante and the
  blinds, every action, each street, the showdown and who won, and the level
  going up. The strip over the felt repeats the last line said - log or chat -
  when the panel is out of view.
- **Info**: the table (the room, the **Game** and its betting - in HORSE,
  _HORSE · Fixed-limit · now Razz_ - the host, the hand number, the players,
  how many are on the rail), the blinds or the stud bets with your stack in
  big blinds or big bets, the level and the time to the next one, the whole
  structure with the level the clock is on marked (and, in HORSE, each
  level's game), the field (tables left, which one you are at, players
  remaining, entries when re-entries or add-ons have made them more, your
  rank, the average and the chip leader, where the money starts, the
  payouts), a **Copy rail link** button, and, for the host, the Host block
  described in [The host at the table](#the-host-at-the-table) and, in an
  invite-only game, whoever is waiting at the door. A watcher sees a
  **Watching** block here instead, to pick a table. Busted with re-entry
  open, a **Re-enter** button with its cost; seated during the first break
  with the add-on on, **Take the add-on** with its ([Being
  eliminated](#being-eliminated) and
  [How a tournament runs](#how-a-tournament-runs) say what each costs). When
  the game ends, the final standings.
- **Stats**: the leaderboard, and your last ten hands. In a tournament the
  board covers the whole field: everyone who entered, ranked by stack, with
  the players who have busted below them in finishing order with their
  place, and your own record follows you when you are moved to another
  table. At a casual table it is that table's. Either way it holds hands
  played, hands won and the biggest pot taken. Your last ten hands are
  counted for how often you put chips in and raised on the opening street,
  and the biggest pot you won.
- **History**: the last ten hands dealt at the table you are sitting at, each
  with its pot and winner. Pick one and it opens as a page: the pot, the
  stakes, the street it ended on, who won it (_Winner_, _Split pot_,
  _Winners, from separate pots_, or _High and low_), each seat's cards -
  only cards that were shown at the table appear, and a hand that was kept
  down reads _mucked_ - the board, and the action street by street.

  Underneath the list, **Transcript (.txt)** and **Data (.json)** write the
  whole game to a file: every hand you were dealt into, following you across
  any table you were moved to, oldest first. The transcript reads as a hand
  history - the streets down the page, your cards, the board and what
  everybody did - and the JSON is the same hands for anything that reads by
  machine. Both hold exactly what was already on your screen, and a busted
  player can still take theirs. A running server keeps the last 500 hands of
  a game (`HAND_HISTORY_MAX`); the file says which hand it starts at, so one
  cut short by that does not read as the whole game. The game you are playing
  is written down as it goes, so a server restart does not lose what came
  before it, and **your games** in the lobby menu has the ones you have
  finished - see [Your games](#your-games).

### How the cards look

**cards** in the table menu holds three settings, and all three are about how
you read the cards rather than about the game:

- **The back** they are dealt with: green, red, blue or ivory.
- **The suits**: the classic two colours, or four, where the diamond is blue
  and the club is green. The spade stays black and the heart stays red. It is
  what stops a club being taken for a spade at a glance.
- **The face**: standard, or a large index, which grows the rank and its suit
  a tenth again. Worth it on a phone.

Nobody else sees any of it. Two people at the same table can be looking at
different backs and neither can tell, because the cards are the same cards and
this is only the reading of them. The choice follows your account rather than
the browser: set it on the laptop and the phone is dealt the same deck.

### Leaving and coming back

The door in the table's top-left corner takes you back to the lobby, and
**leave** in the table menu is the same thing said another way; either asks
first. Your stack stays in the game, sitting out and blinding down, and the
game stays under **Your tournaments** with a **Rejoin** button that puts you
back in control of it.

**forfeit**, under it in the same menu, is the other way out: the one for
somebody who is not coming back. Your chips leave play there and then, you
finish in the place you hold at that moment and are paid if that place pays,
and the seat is gone rather than blinding down for the rest of the game. It
asks first, because nothing undoes it: a player who forfeits is not offered
re-entry, even if the window is open. You can still watch, and a game you
walked out of earlier carries a **Forfeit** button beside **Rejoin** on its
lobby card, so a stack you left behind can be given up without sitting down
again. Asked for while a hand is being played, the seat goes when that hand
ends, and the felt says so.

A dropped connection does the same without the leaving: the top of the page
says _Reconnecting…_, your seat sits out until you are back, and the page
rejoins on its own. So does a reload, and so does the same identity on
another device.

If everybody with chips has gone, the table holds rather than playing on. The
banner reads _Holding · waiting for players_, no hand is dealt, the blind
clock stands still, and every stack stays exactly where it was left. Play
picks up the moment anyone is back at a seat. Watching does not count for
this and neither do the demo seats: a rail full of people who have busted is
a room with nobody left to play. A game held this way is written off after
`TOURNAMENT_ZOMBIE_HOLD_MS`, six hours by default, and the people who were in
it are told it went.

### Being eliminated

When your stack is gone you are out, with a finishing place - _You finished
#7 of 12_, and what it won if it won anything - and a note that the place may
still move while late registration is open. You can stay and watch the table
you were at, or go back to the lobby. Watching, you can still talk in that
table's chat, marked **rail**, and the Info tab's **Watching** block lets you
move to another table.

If the game allows re-entry and the window is still open, the same dialog
offers **Re-enter** beside Watch, with the buy-in and the level it is open
through, and the Info tab keeps a **Re-enter** button for as long as the offer
stands. Saying no is not final and neither is leaving: the game's card in the
lobby, under **Your tournaments**, carries a **Re-enter** button too, for as
long as the window is open, and taking it from there puts you straight back
at a table. The **Add-on** is on the card in the same way during the break,
for somebody who is not at their table when it starts. Neither is offered to
somebody who forfeited: giving the seat up is final, which is what the
question before it is for. Taking it costs another buy-in and seats you with
a fresh starting stack at the table with the fewest players, joining at its
next deal. Your bust-out is struck from the standings, as if it had not
happened.

The host can also remove you. Then your chips leave play, you finish in the
place you held, paid if that place pays, you are sent back to the lobby with
a note saying so, and the code will not let you back into that game.

A seat that goes without a hand to account for it — a forfeit, or the host
removing somebody — is said over the felt for a few seconds as well as in the
dealer's log, so nobody has to have the Log tab open to notice.

## How a tournament runs

**Blinds** follow the structure chosen at creation. Standard climbs eighteen
levels from 10/20 to 3000/6000, with antes from level 6 and a break after
levels 6 and 12. Turbo climbs faster over fifteen, with antes from level 4
and no break. Deep climbs slowly over twenty-four, with antes from level 9
and breaks after 8 and 16. Every level lasts the level length chosen at
creation unless the host edited it. The clock runs across every table at
once, and the whole ladder is in the waiting room and in the Info tab, with
the level the clock is on.

**What a level means depends on the game.** In the blinds games - Hold'em,
Omaha, Omaha Hi-Lo, Crazy Pineapple and Five-Card Draw - the row's small and
big blind are posted as blinds, and its ante is a big-blind ante: from the
level the structure says, the player in the big blind posts an ante equal to
the big blind straight into the pot, then the blind. It is not part of the
price to call, and a short stack posts the ante first and the blind out of
what is left. In the stud games - Seven-Card Stud, Stud Hi-Lo and Razz -
every seat antes every hand: the ante is half the row's small blind (at least
one chip), the small blind is the bring-in, and the big blind and twice it are
the two bets; the row's own ante column is not used. Under fixed-limit in any
game, a bet is the big blind and, from the game's big-bet street, twice it.
In HORSE the level also says which game is dealt - Hold'em, Omaha Hi-Lo,
Razz, Seven-Card Stud, Stud Hi-Lo, round again from level six - and a hand
already running when the level turns finishes as the game it was dealt.

**Breaks** are levels with no blinds. When one arrives, a hand in play
finishes and no table deals until it is over; the banner reads Break with the
blinds play resumes at, and the cleared felt counts the break down. A level
number counts levels of play, so a break never takes one.

**A pause** is the host's: the hand in play finishes, no table deals, and the
clock stands still until the host resumes. **A removed player** is out as if
they had busted: their stack leaves play, their finishing place is the one
they held, and their registration is gone.

**Late registration** stays open through the level chosen at creation, and
through the break after it if there is one. A late entrant sits down with the
starting stack at the table with the fewest players, joining at that table's
next deal; when every table is full, a new table is opened for them, and that
table is the first to be broken as the field shrinks.

**Re-entry and add-ons.** A game is a freezeout unless the host chose
otherwise when making it. With re-entry open through a level, a busted
player can buy a fresh starting stack and sit down again, the way a late
entrant does, as many times as it takes while the window is open; with the
add-on on, everyone still seated during the first break can buy one
starting stack more, once. The break asks each of them, so the offer does not
have to be gone looking for. It waits its turn: the hand in play finishes, the
felt clears, the break clock comes up, and then the question slides in under
it with **No thanks** and **Take it** on it. Nothing is covered, so the clock
that says how long you have to decide stays where you can read it. Saying no
puts it away for that break and leaves it where it was, in the Info tab and on
the game's lobby card. Asked for while the table is still finishing a hand,
the add-on lands when the hand does. Each costs a buy-in, and each goes into
the prize pool. The host can remove a player who abuses it.

**Tables balance and break** as players bust: no table is ever more than one
seat different from another, and a table is broken when the field fits on one
fewer, until one table is left. A move needs both tables between hands, so
the table that is due to break, or the biggest one when the tables are more
than a seat apart, sits out one hand while the other finishes; then the move
is made and dealing carries on. The table sizes are what the game allows: a
stud game or HORSE fills tables of seven, so a field of the same size needs
more of them. Otherwise a table waits only for a seat (heads-up, with an odd
number left), for the host's pause, or for a shown hand to be seen.

**The bubble.** One place before the money the game announces the bubble -
the paid places come from the payout table by field size, so a game with no
buy-in has a bubble too, for a place rather than a payout. While the field is
still spread over more than one table it also plays hand for hand: a table
that finishes its hand early waits for the others, so nobody can stall their
way into a payout. Down to one table there is nobody to wait for, so the
bubble is announced and play simply carries on. When the bubble bursts,
everyone left is in the money.

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

**The end.** The last stack standing wins. Everyone at the table is told who

- _You won the tournament_, or who did, with the top three - the final
  standings appear on the Info tab, and the game stays on the lobby's Finished
  list for ten minutes.

**Nobody home.** A running game whose players have all gone is not ended: it
holds, as [Leaving and coming back](#leaving-and-coming-back) says, and is
written off only after six hours of nobody coming back. A game still
registering deals itself at its start time once two are in; with fewer it
waits, and is cancelled thirty minutes past its time with nobody else come,
or removed at once if nobody at all is registered. A server restart loses
nothing: registrations and a running field are recorded between hands and
come back as they were, every seat sitting out until its player is back, and
everyone's page rejoins on its own. A field that cannot be restarted - one
that came back several times without finishing a hand - is held with a note
for the host rather than dealt again.

## Chat, reactions and mute

Chat lives in the waiting room before the start and in the table's Chat tab
after it. Messages are up to 200 characters, four in ten seconds. The last
hundred lines are replayed to anyone who reloads or rejoins, so a late
arrival sees the conversation so far.

The **host** can **mute** anyone from the waiting-room roster - nobody can
mute the host - and unmute the same way. A muted player can read but not
post, sees _The host has muted you_ when they try, and cannot throw reactions
either. The mute lasts for the game.

The **host hears every table** in their game, live, whichever they are
sitting at, and can speak to one table or to all of them from the strip in
the Chat tab. A line to all tables is marked "to all tables" and flashes
over the felt for a few seconds, so a closed chat panel is not a missed
break call. A host who busts keeps the floor.

Anyone watching a table, from the rail or after busting, can read the waiting
room's chat and talk in a table's once the cards are out; their lines carry a
**rail** badge, so a seat can tell who is playing from who is only talking.
The host's mute covers them. Reactions are for seats only: they float over a
chair, and a watcher has none.

An admin can switch reactions off for the whole server from the Admin page's
Server tab; then the strip simply does not exist. Chat is switched off in the
server's environment (`CHAT_ENABLED`), for the reason given under
[The Admin page](#the-admin-page).

## Updates

When the server is updated, a page that was already open notices on its next
connection. In the lobby it reloads itself straight away. At a table it shows
_FinalTable was updated_ across the top and reloads once you leave the table;
tap the notice to reload sooner. Nothing is lost either way: a reload rejoins
your seat.

## For the admin

The admin is an account. On a fresh server it is whoever makes the first one,
through any door - a sign-up, a GameNight sign-in, or most simply by claiming
the server from the sign-in card with the token in its `.env`, which needs no
mail and lands you on the Mail tab to set some up. After that, an
administrator makes another from the Users page. There is nothing to type and
nothing to unlock: the **admin** item in the lobby's corner menu is there for
an administrator and nowhere else, and it stays there across a reload, a
reconnect and a restart.

If a server ends up with nobody administering it - it was upgraded from a
version before accounts, a stranger signed up first, or the only
administrator lost their password and their address - whoever runs the box
names an account in `ADMIN_PROMOTE` and restarts it. That is written down in
[DEPLOYMENT.md](./DEPLOYMENT.md#who-administers-the-server). The old
`ADMIN_PASSWORD` does nothing now, and the boot log says so if it is still
set.

### An account of your own

How to make one is under [Who you are](#who-you-are). What it is worth knowing
besides:

**Forgot your password?** sends a link to the address you signed up with. It
works once and lasts an hour. The answer on screen is the same whether or not
that name has an account, because who plays here is not a list to hand out.
**change password** in the corner menu changes it without signing any device
out.

No other player is ever shown your address. An administrator can see one
account's address at a time from the Users page, and the Log says every time
one did.

A server with no mail set up cannot confirm an address, so it makes no new
accounts and says so where the buttons would be. Accounts somebody already has
still work, and so does the GameNight sign-in if the server is paired with
one. If you signed up and the link never came, ask whoever runs the server:
your sign-up is held for a day, and they can let you in from the Users page.
You then sign in with the name and password you chose.

### Your games

**your games** in the lobby's corner menu lists every game you have played that
the server still keeps, newest first, with how many hands you were dealt into
and when it ended. **Transcript** and **Data** on a row write the same two
files the History tab writes at the table, for that game.

A game is only listed for the people who played in it, and asking for one you
were not in is refused rather than answered with an empty file. They are kept
for thirty days (`HAND_HISTORY_TTL_MS`) and the server keeps the most recent
200 games (`HAND_HISTORY_MAX_GAMES`), whichever runs out first.

### The Admin page

Six pages behind one strip of tabs: **Games**, **Sign-in**, **Mail**,
**Server**, **Users** and **Log**. One shows at a time, it opens on Games, and
**Back to the lobby** is below all of them. The arrow keys walk the tabs.

**Games on this server** is the page it opens on: every game the server holds,
listed or not, running first, then registering, then finished. Each card shows
the status, how the game is listed (public, private or invite-only), the
**join code**, the host, the game and its betting, the table size and the
starting stack, how many registered players are connected, the entrants, the
tables while running, how many are waiting at the door of an invite-only
game, and when it was created or started.

A running game also says **what it is doing**: dealing, between hands, paused
by the host, on a break, holding for an empty room (and since when), waiting
for a seat, or waiting while the field rebalances - with how many hands have
been played and, once it has been quiet for a while, when the last hand was.
Under that is the shape of the field, a pip per table saying whether it is
dealing (▶), idle (·) or broken (✕) and how many are sitting at it, so
`1 ▶ 2  2 ▶ 2  3 · 1` reads as two matches in play and one player waiting
for an opponent without opening a single table.

**End game** ends one, after a confirmation; everyone in it is sent to the
lobby with a note saying the admin ended it. The page keeps itself up to date
while it is open, and follows the server as games come and go; **Refresh**
asks again at once.

The page follows the account rather than the connection: a server restart or a
laptop waking up reconnects, signs back in, and the page is still there.

This is the one place an unlisted game and its code are shown to somebody
who is not in it. Hand codes out with care.

**Sign-in** pairs the server with a GameNight site so players can sign in
with their account there. Register the server on GameNight first (Site
Settings › Connected Apps), then enter the GameNight address and the slug
here; the signing key is fetched, nothing is pasted. **Refresh key** if
GameNight regenerates its key; **Unpair** takes the button away. The full
procedure is in [DEPLOYMENT.md](./DEPLOYMENT.md#pairing-with-gamenight).

The same tab holds the key for the other direction. **Make a key** makes the
one GameNight presents to make games here (see [the API](./API.md)); it is
shown once, with a **Copy** button, and never again - paste it into
GameNight's Connected Apps entry for this server. **Make a new key** replaces
it and the old one stops working; **Revoke** leaves none, which stops
GameNight until another is made. The tab says when the key was made and
when it was last used.

With the key GameNight makes a game - its name, start, game and betting,
blinds, stack, seats, buy-in, add-on and re-entry, and a roster that becomes
the game's guest list, whose manager is the host and who are all known to
this server before they arrive - reads how it is going, starts, pauses,
resumes and cancels it, moves a player or takes one out of play, and can sign
a GameNight player out of every browser here. The key drives every game made
over the API and none made at the create form here: a form-made game answers
it the way a wrong id does, so pairing a GameNight does not hand it the room.
The join and rail links a game is given back are built on the Mail tab's
public address, so set that before the first one. A game is refused while its
host is already in one, or when the server is full.

A game made with a webhook reports back to GameNight as it runs - every
bust-out and re-entry, the start, every level, break, pause and resume, the
ending or the cancellation, and a heartbeat every few minutes while it lives.
Each report is signed and tried again for about a day if GameNight is not
answering, and the Log says when one could not be delivered and when the
server gave up. A game reports only to the GameNight this server is paired
with: a webhook aimed anywhere else is refused when the game is made, and a
server with no pairing and no `WEBHOOK_ORIGINS` refuses one outright. If your
receiver lives somewhere other than the address people sign in through, name
its origin in `WEBHOOK_ORIGINS`. The rule is applied again when games come
back after a restart, so an address that would be refused today is dropped -
that game keeps running and reports to nobody, and the Log says so. The Log
also has a row for everything GameNight does here: the game it made and for
whom, and each start, pause, cancel, move or removal.

**Mail** is how this server sends the two messages it sends — the link that
proves an address at sign-up, and the one that sets a forgotten password.
Without it nobody can make an account, so on a new server this is the first
page to fill in.

Give it the **public address** players actually reach the server on: links in
the mail are built against it, so behind a proxy that is the proxy's address
rather than the container's. Then choose how to send. **Through a mail
server** wants the host, the port, whether TLS starts from the first byte
(usually port 465) or not (usually 587), and the account to sign in as. The
**from** address should be one that server will send for - a relay only sends
for domains it has verified, and refuses the message rather than the login
when it is not.
**Write it to this server's log instead** sends nothing and puts the whole
message where `docker logs` will show it, which is how to try the whole flow
on a machine with no mail server. **Not at all** means nobody can sign up.

**Test and send me one** tries what is on the screen rather than what was
saved, so a setting can be proved before it is kept: it opens the connection,
signs in, and sends one message to your own address. When it will not work it
says what the mail server said, which is usually the whole answer.

The password is typed once. It is never shown again — not to you, not to
anybody — so the box is empty whenever you come back and leaving it empty
keeps what is stored. **Forget the password** is there for when you mean to
clear it.

**Server** is the handful of things that can be changed without a restart: how
many games the server holds at once (finished games still showing their
standings count), whether the reaction strip exists, how long hands are kept
(in days; zero means no age limit, only the count) and how many games' worth,
and the two pauses that set the pace of a table - between hands and between
streets. Each row says when it takes effect. **now** means the next person to
ask; **next game** means games made from here on, because a table is handed
its pacing when it is made and keeps it. Until **Save** is pressed once, the
server's environment governs these; after that the page does.

Chat, and how many hands a running game keeps, are still set in the server's
environment. Neither is a flag the server merely consults — with them off, the
thing they write to is never built — so a switch on the page would work in one
direction and not the other.

**Users** is everybody with an account here - including the people on a
GameNight roster who have not arrived yet, with no devices. Search by name,
or show only administrators or only suspended accounts; **Show more** pages
on. A row says how many devices they are signed in on and when they were last
here, is tagged administrator, suspended or GameNight, and carries what can be
done about them:

- **Open** shows the one thing the list leaves out - their email address -
  along with how many games of theirs are kept and how many browsers they have
  open. The Log records every time an address was looked at, because an
  address is the most sensitive thing this server holds about somebody.
- **Make admin** and **Stand down** hand the server's controls over, or take
  them back. Somebody standing down is fine; leaving the server with no
  administrator at all is not, so the last one cannot be stood down, suspended
  or deleted, and nobody can suspend or delete themselves. A suspended account
  is let back in before it can be made an administrator.
- **Suspend** signs them out everywhere and refuses them at every door until
  **Let back in**. This is what to do about somebody who is a problem mid-game.
- **Sign out** ends every browser they are signed in on without touching the
  account - the thing to do about a laptop left in a hotel.
- **Reset password** sends them the same link **Forgot your password?** would.
  A GameNight account has no password here, so it is not offered one.
- **Delete** takes the account and every device with it. The games they played
  are kept, with their name still on them. A GameNight account cannot be
  deleted - its id belongs to GameNight, so it would come back on the next
  sign-in, and without the suspension - so suspend one instead.

**Waiting on email**, shown only when there is somebody in it, lists the
sign-ups whose link has not been opened - who asked, their address partly
hidden, how long ago, and when the hold lapses. **Let them in** does what the
link would have: the account exists, and they sign in with the name and
password they chose. It is for the mail that never arrived, and the Log says
who did it.

**Make an account** below the list creates one for somebody by name and
address. No password is set: a link goes to them and they choose their own, so
whoever made the account never knows it. It needs mail set up, like every
other account on the server.

**Log** is what this server has done, newest first. A row for every game and
how it ended - a winner, cancelled by the host, the admin or GameNight,
written off after everybody walked away, or nobody else came - with the
entrants, the level it reached and who finished where, to eighth place. A row
for each person's visit - one when they arrive, not one every time their
browser says hello, so a reload or a dropped connection does not bury the
games (`ADMIN_LOG_SIGNIN_GAP_MS`, an hour by default; zero writes one every
time). A row for each thing an administrator did from this page - let
somebody in, made an account, made or stood down an administrator, suspended
or restored or deleted an account, set the mail. A row for every restart,
which is what answers "has this thing been coming up over and over". And a
row for anything that logged a warning or an error, which is the half that
says why - among them a row when a game GameNight made could not report back
to it, and one when the server gave up trying after a day.

It is kept in the database, so it survives a restart, and entries drop off
both by age and by count so it cannot grow without end (ninety days and two
thousand rows: `ADMIN_LOG_MAX_AGE_MS` and `ADMIN_LOG_MAX_ROWS`). New entries
appear while the page is open, without touching anything; **Refresh** asks
again at once. **Show older** pages back through it, and once you have, the
page stops following so nothing moves under you while you read; opening the
Log again starts at the newest.

What is never written to it: a hole card, a device token, a password, a
join code, or a webhook secret. An admin runs the server, which is not the
same as being allowed to see everybody's cards, and a log a browser can read
is a log that leaks if anything else does.

### From the table

The table menu offers **cancel tournament** for the game at that table, to an
administrator and to nobody else. It is the same thing as End game on the
Admin page, reached without leaving the felt.

### Server settings

These live in the server's `.env` (see `.env.example`) and take effect when
the container is restarted or recreated. The Mail rows seed the Mail tab the
first time a server boots, and that page wins from then on. The Server-tab
rows are read from the environment on every boot until somebody presses
**Save** on that tab, which stores all of them; after that the page wins. So
they are for a headless setup, and for a box nobody has pointed a browser at
yet, rather than the place to change a setting on a server that is running.

| Setting                                      | Default       | What it does                                                                          |
| -------------------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `DB_PASSWORD`, `DB_ROOT_PASSWORD`            | none          | The database's passwords; the server refuses to start without them.                   |
| `ADMIN_PROMOTE`                              | none          | An account to make an administrator at boot, by name.                                 |
| `CLAIM_TOKEN`                                | none          | Lets a server with no administrator be claimed from the sign-in card; 16+ characters. |
| `MAX_TOURNAMENTS`                            | 8             | Server tab: how many games the server holds at once.                                  |
| `CHAT_ENABLED`                               | true          | Chat exists at all.                                                                   |
| `CHAT_HISTORY`, `CHAT_MAX_LEN`               | 100, 200      | Lines replayed to a late arrival; the longest message.                                |
| `CHAT_RATE`, `REACTION_RATE`                 | 4, 3          | Messages and reactions allowed per ten seconds.                                       |
| `REACTIONS_ENABLED`                          | true          | Server tab: the reaction strip exists at all.                                         |
| `HAND_PAUSE_MS`, `STREET_PAUSE_MS`           | 2000, 1600    | Server tab: the pause between hands and between streets.                              |
| `SHOW_WINDOW_MS`                             | 5000          | How long a hand may be shown after an uncontested pot. Zero switches showing off.     |
| `TOURNAMENT_FINISHED_TTL_MS`                 | 600000        | How long a finished game stays listed (ten minutes).                                  |
| `TOURNAMENT_ZOMBIE_HOLD_MS`                  | 21600000      | How long a held game waits for somebody before it is written off (six hours).         |
| `HOST_TRANSFER_GRACE_MS`                     | 120000        | How long a missing host keeps the game before it passes.                              |
| `GAMENIGHT_URL` and friends                  | none          | Seed the GameNight pairing on a first boot; the page wins after.                      |
| `WEBHOOK_TIMEOUT_MS`                         | 8000          | How long one webhook to GameNight waits for an answer.                                |
| `WEBHOOK_HEARTBEAT_MS`                       | 300000        | How often GameNight is told a game is still here. Zero turns it off.                  |
| `WEBHOOK_ORIGINS`                            | none          | Extra origins a game may report to, besides the paired GameNight's.                   |
| `HAND_HISTORY_MAX`                           | 500           | Hands a running game keeps for the download. Zero turns it off.                       |
| `HAND_HISTORY_TTL_MS`                        | 2592000000    | Server tab: how long a game's hands are kept (thirty days).                           |
| `HAND_HISTORY_MAX_GAMES`                     | 200           | Server tab: how many games' hands are kept at once.                                   |
| `ADMIN_LOG_SIGNIN_GAP_MS`                    | 3600000       | How long after a visit the Log waits before writing the same person's next.           |
| `ADMIN_LOG_MAX_AGE_MS`, `ADMIN_LOG_MAX_ROWS` | 90 days, 2000 | When Log rows drop off.                                                               |
| `PUBLIC_URL`, `SMTP_URL`, `MAIL_FROM`        | none          | Seed the Mail tab on a first boot; the page wins after.                               |
| `MAIL_TRANSPORT`                             | none          | Seeds the Mail tab: `log` writes mail to the server log. Development only.            |

There are more, for the box rather than the game - the proxy it trusts, the
origins it allows, connection and request limits, the process's memory - all
named with their defaults in `.env.example` and explained in
[DEPLOYMENT.md](./DEPLOYMENT.md).

## Privacy and fairness, briefly

Your hole cards are sent to your browser and nobody else's; every other seat
receives a view with them blanked, and they are shown only at a showdown, at
a run-out with two or more live hands, or where you turn one over yourself -
after taking a pot nobody contested, or after folding. The exception is by
design: a stud card dealt face up is sent to every seat, because that is what
an up-card is, and the cards dealt down stay as private as any other. The deck
is shuffled with the operating system's random source. There is no public
list of games: the lobby's list and the API's need somebody signed in, an
unlisted game reaches only the people in it, and a game's id without its code
gets "Tournament not found". What a code alone gives anyone who has it is what
the link's own screen shows - the game's name, when it starts, the game, the
blinds and how many are in - which is why a link is an invitation. A watcher
on the rail gets the same blanked view as any other seat, is never sent the
join code, and cannot sit down by the rail link. The admin, who runs the
machine, can see every game and its code, and can look at one account's email
address at a time, which the Log records; a paired GameNight's key sees the
games it made. That is the extent of it. The details, with the code paths and
the tests behind them, are in [SECURITY.md](../SECURITY.md).
