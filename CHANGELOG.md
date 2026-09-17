# Changelog

What changed in FinalTable, newest first. This is the player's and the
admin's view: what behaves differently, not how it was built. For lineage
and what the fork removed from upstream see [FORK.md](./FORK.md); for the
reasoning behind any one change, the git history says more than a line here
can.

Entries are grouped as Added, Changed, Fixed and Removed, roughly following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
[semver](https://semver.org/), and a version heading means a `v*` tag and a
Release on GitHub to go with it.

## Unreleased

### Added

- Your hands keep for thirty days. The game you are playing is written down as
  it goes, so a server restart no longer loses the hands played before it, and
  **your games** in the lobby's corner menu lists every game you have played
  that is still kept - with the same **Transcript** and **Data** downloads the
  History tab has at the table. A game is only listed for the people who played
  in it, and asking for one you were not in is refused rather than answered
  with an empty file. Thirty days by default (`HAND_HISTORY_TTL_MS`), and the
  most recent 200 games (`HAND_HISTORY_MAX_GAMES`).

### Fixed

- A game that comes back from a restart carries on counting its hands instead
  of starting again at one. The felt said "Round 1" over a table that had
  played twenty, and a downloaded history had two hand 1s in it.

## 0.19.0 - 2026-09-16

### Added

- Your hands are yours to keep. Under the **History** tab, **Transcript
  (.txt)** and **Data (.json)** write the game you are playing to a file:
  every hand you were dealt into, following you across any table you were
  moved to, rather than the ten the panel shows for the table you happen to be
  at. Busting out does not take it away. The files hold what you could already
  see - your own cards, the board, every action, and whatever was turned face
  up - and never anybody's folded holding. A server keeps the last 500 hands
  of a game for this (`HAND_HISTORY_MAX`), and the file says which hand it
  starts at.

## 0.18.1 - 2026-09-16

### Fixed

- The Admin page's **Log** keeps one row for each person's visit rather than
  one every time their browser says hello. A row went in on every page load,
  reload and reconnect, so an evening of testing left eight rows for one player
  and one for the game they played - and since the log is bounded, that noise
  would eventually have pushed the games off the end of it. An hour by default,
  set with `ADMIN_LOG_SIGNIN_GAP_MS`; somebody the server has never seen is
  always written down.

## 0.18.0 - 2026-09-16

### Added

- The Admin page's **Games** list says what each game is actually doing -
  dealing, between hands, paused by the host, on a break, holding for an empty
  room, or waiting for a seat - with how many hands have been played, when the
  last one was once it has been quiet for a while, and a pip per table showing
  whether it is dealing and how many are sitting at it. The **Games** and
  **Log** pages keep themselves up to date while one of them is open, instead
  of showing whatever was there when it was opened. Paging back through older
  log entries stops the Log following, so nothing moves while you read.

### Fixed

- The Admin page says when its unlock has gone. It lives on the connection, so
  a server restart or a laptop waking up ends it - and every admin request was
  then answered with silence, which from inside the page looked like a Log that
  would not load. It now says so and offers the way back in, landing on the
  page you were reading.

- A seat plate no longer cuts a badge in half. It shows the one thing worth
  saying about that seat right now, so a host who is sitting out reads
  "sitting out" rather than "HO SITTIN". The host is still named on the Info
  tab, in the roster and in the seat's own menu.

## 0.17.0 - 2026-09-15

### Added

- The Admin page's **Log** holds what the server has done, rather than saying it
  holds nothing. Games and how each one ended - a winner, cancelled, or written
  off after everybody left - with who finished where; sign-ins; restarts; and
  anything that logged a warning or an error, which is the half that shows a
  server that has been crash-looping. It survives a restart, and old entries
  drop off by age and by count so the file cannot grow without end. No hole
  card, device token, password or join code is ever written to it.

### Changed

- The Stats tab's leaderboard covers the whole tournament rather than the table
  you happen to be sitting at. Everyone who entered is on it, ranked by stack,
  with the players who have busted below in finishing order - and your own
  record follows you when you are moved to another table instead of starting
  again from nothing. It shows stacks now in place of the win rate, which was
  the two columns beside it divided.

### Fixed

- A table with nobody to deal to now says so. At heads-up an odd number of
  players cannot be seated in pairs, so one of them waits for a seat: the felt
  reads "Waiting for a seat" and the banner "Waiting · for an opponent" until a
  match somewhere else ends, instead of sitting on the last hand with nothing to
  explain it. A table held while another is being broken up says that too.

## 0.16.4 - 2026-09-15

### Fixed

- Leaving a table no longer tells you a second time. The dialog on the way out
  already says your stack sits out and you can rejoin, and the lobby behind it
  shows the game with a **Rejoin** button on it, so the notice that used to
  open there said nothing new. Being removed by the host still says so - nobody
  asked you about that one.

## 0.16.3 - 2026-09-15

### Fixed

- The raise button now says the amount it is about to bet. Pressing a preset or
  dragging the slider changed what the second tap would send without changing
  the number on the button, so it could read **raise 240** and bet **600**.
- On a phone the chips sweeping into the pot come from the players again rather
  than flying in from off the top of the screen, and the chips going in animate
  again as well.

## 0.16.2 - 2026-09-15

### Fixed

- The chips a player has bet no longer hide behind their own cards. They were
  drawn at one size for every screen and on a bearing that put them inside the
  chair that made them once the felt got small; they are smaller now and sit
  clear of the chairs, their cards, the board and the pot at every size that
  has room for them. On a phone, and on a laptop narrow enough that the side
  panel leaves the felt phone-sized, they come off the cloth altogether - the
  amount is on every plate as **in 20**, where nothing can cover it.

## 0.16.1 - 2026-09-15

### Fixed

- On the large card face the suit under the rank no longer runs into the corner
  index, and the rank no longer sits on the suit. The suit and the indices keep
  the size they have on an ordinary card - there is no room on a card for all
  four to grow at once - and the rank, which is the thing a large index is for,
  is the one that gets bigger.

## 0.16.0 - 2026-09-14

### Added

- When a pot is pushed, the amount floats up over the chair that won it as the
  chips arrive, and fades. A split pot floats each winner their own share.
- Two controls in the top corners of the felt, neither of them needing a word.
  A **door** on the left takes you back to the lobby, exactly as **leave** in
  the menu does: your stack stays at the table sitting out and you can rejoin
  by code, and a watcher on the rail simply stops watching. A **speaker** on
  the right turns the sound off and on, drawn with waves while there is sound
  and crossed out when there is not; **mute sound** in the menu is the same
  switch. Both sit inside the felt rather than over the side panel, and move
  with it.
- **cards** in the table menu: choose the back the cards are dealt with (green,
  red, blue or ivory), the classic two-colour deck or a four-colour one where
  the diamond is blue and the club is green, and a large index on the card face
  for anyone reading a phone at arm's length. Nobody else's table changes, and
  the choice follows you to your other devices.

## 0.15.0 - 2026-09-14

### Added

- A **Log** page on the Admin page, empty for now. It will hold what the server
  has done - games that finished, sign-ins, restarts, and anything that logged
  a warning - and until then it says so, because the server writes its log to
  its own output and keeps no copy.

### Changed

- The Admin page is four pages behind a strip of tabs rather than one long
  scroll: **Games**, **Sign-in**, **Password** and **Log**. It opens on Games,
  the arrow keys walk the tabs, and **Back to the lobby** sits below all of
  them. Nothing any of it does has changed.
- The **Operator** page is now the **Admin** page, and every word for it says
  admin. It was Operator wherever a person read it and admin wherever the code
  wrote it, including `ADMIN_PASSWORD`, which meant the password and the page
  it unlocked went by different names. Nothing about what it does has changed,
  and no setting has changed name.

### Fixed

- The turn clock no longer counts down over a table that has not been dealt
  yet. The server arms it the moment a hand starts, which on a full table is
  about a second and a half before the cards have finished flying, so the ring
  appeared round an empty seat and was already running by the time you could
  see what you had. It waits for the last card to land now. The clock itself is
  unchanged, so the ring you then see is the time you actually have.

## 0.14.0 - 2026-09-14

### Added

- **Your devices**, in the lobby's corner menu when you are signed in with a
  Game Night account. It lists where you are signed in, names each one and says
  when it was last here, marks the one you are reading, and signs any of them
  out. Signing a device out takes it back to the lobby as a stranger; a stack
  it left in a game stays where it is.
- Mute, the chair you sit in and the panel tab you leave open now follow you
  between devices. They are kept against who you are rather than against the
  browser, so signing in with a Game Night account on the phone and then the
  iPad gets you the same table on both. A guest is still one browser, which is
  the most a guest can be, and nothing here is slower: the setting is applied
  at once and the server is told afterwards.

### Fixed

- **Sign out** now ends the session on the server rather than only clearing the
  browser. Until now the device stayed signed in here for another thirty days,
  which meant a device you had signed out of was still on your own list of
  devices and its token still worked.

## 0.13.0 - 2026-09-13

### Fixed

- Stepping away no longer ends the tournament. A running game whose people had
  all dropped was torn down two minutes later, so a phone locking in a game
  against the demo seats, or a table that all reached for their phones at the
  break, lost the game and everybody's chips. The table holds instead: the
  banner reads **Holding · waiting for players**, nothing is dealt, the blind
  clock stands still, and every stack sits where it was left until somebody is
  back at a seat. A seat whose player has gone is still sat out, as before, so
  one person stepping away has never stopped the others playing.
- Somebody on the rail no longer keeps a game alive on their own. Watching is
  not playing, so a busted player with a tab open is not a reason to go on
  dealing to a table nobody is at.

### Changed

- The host's **Pause** reads **Waiting for players** and is out of use while
  the table is holding for an empty room, rather than offering a button that
  does nothing. A game the host paused and then walked away from is held for
  both reasons, and coming back lifts only the one that was about the room.
- A game held for an empty room shows as **holding** on its lobby card, and on
  the Operator page with the time the hold began.
- The action bar on a phone held upright. It was four rows deep and a third of
  the screen, with nothing on it big enough to hit reliably: the mobile layout
  the stylesheet already had only applied in landscape, so portrait fell
  through to the desktop button widths inside a 390px bar and wrapped three
  times. It is one row now - **fold**, **check** or **call**, **raise** - each
  a thumb wide and tall, with the raise presets, slider and amount a tap behind
  the raise button and a confirm that says what it will cost. The slider gets
  the width of the bar instead of the fifty-odd pixels left beside the number.
  **+30s** moved up beside your stack, where it cannot push the buttons onto
  another line. Nothing changes on a desktop or in landscape.
- The bar no longer sits in the home indicator at the bottom of a phone screen.
  The same goes for the sit-out banner and the row of early choices, which
  share that slot.
- Your own two cards are now the size of the cards in the middle of the table.
  They were the smallest thing on the felt, which is a strange place to put the
  hand you are actually reading. Everybody else's stay as they were: eight
  seats of board-sized cards is what crowds a table. They match at every
  window size, including where the board itself changes size, and at phone
  widths the name plate under them gives up the room rather than the cards
  going small again.

### Removed

- `TOURNAMENT_ABANDON_GRACE_MS`, which set how long a running game survived
  with nobody connected. Nothing is torn down for that reason any more.
  `TOURNAMENT_ZOMBIE_HOLD_MS` replaces it, and is how long a held game waits
  for somebody before it is written off: six hours by default, where the old
  one was two minutes. A server setting the old variable should drop it, or
  the value will be ignored.

## 0.12.0 - 2026-09-13

### Added

- Showing a hand nobody paid to see. When a hand ends, anybody whose cards
  stayed down can turn them over for the few seconds before the next deal: the
  winner of a pot everybody folded to, and anybody who folded, whether the hand
  went to a showdown or not. Tap one of your own cards to show just that one,
  tap the other as well, or use **both** beside the sit-out button. A card you
  show goes where a showdown's cards go - face up on the felt for everyone,
  named in the dealer's log, and in the replay afterwards - and the one you
  keep down stays as unseen as a fold. Turn something over and the table waits
  long enough for it to be looked at, because a bluff shown and then wiped by
  the next deal is no bluff shown at all. Do nothing and nothing happens, which
  is the point. The table only ever waits on the decision itself after a pot
  nobody contested; a fold shown after a showdown rides the pause that is
  already there. `SHOW_WINDOW_MS` sets the five seconds, and zero switches the
  whole thing off.

### Changed

- Fold is switched off while checking is free, instead of asking whether you
  meant it. Folding when a check costs nothing throws the hand away for
  nothing, so the button is simply dimmed until there is a bet to fold to. The
  "Fold for nothing?" question that used to appear afterwards is gone: a dialog
  on a clock was a worse interruption than the mistake it guarded against.

## 0.11.0 - 2026-09-13

### Added

- Whoever made a tournament can end it while it runs, and goes on being able
  to after they bust out of it. It sits with the host's other controls in the
  Info tab, and on the game's card in the lobby for somebody who is not at a
  table. It asks first and needs no operator password. Until now a host could
  call a game off from the waiting room, but once the cards were out only
  somebody holding the server's password could stop it - and the host title
  passes to another player the moment a host walks back to the lobby, which
  busting out is the usual reason for doing.
- Forfeit: a way out of a game for good, under leave in the table menu and on
  the lobby card of a game you have walked out of. Leaving parks your stack at
  the table, where it blinds down for as long as the game runs; forfeiting
  takes it off the table. Your chips leave play, you finish in the place you
  hold at that moment and are paid if that place pays, and you can still watch
  the rest from the rail. It asks first, because it does not come back: a
  player who forfeits is not offered re-entry, even while the window is open.
  Asked for during a hand, the seat goes when that hand ends.

### Fixed

- Taking the add-on shows. The stack asked for while a hand was still being
  played landed correctly at the hand's end, but nothing on the felt moved to
  say so: the seat went on showing the old number until the break ended and a
  hand was dealt, which looks exactly like the chips never arriving. The table
  is told the moment they land, the press is answered with "at the end of this
  hand" over the felt rather than in a tab, and the stack that arrives says how
  much and what you now have.
- The add-on asks on the felt, in the table's own order. When the break opens
  it, the hand in play finishes, the pot goes to whoever won it, the felt
  clears and the break clock comes up; a beat after that the question slides in
  under the clock, with No thanks and Take it on it. It is not a dialog and
  covers nothing: the clock above it is what says how long there is to decide,
  which the dialog used to hide. Saying no puts it away for that break, and the
  Info tab and the lobby card still hold it. It was only ever a block in the
  Info tab before, and the side panel opens on Chat, so a whole break could go
  by without a player knowing the offer had been on the table at all.
- Busting out, saying no to the re-entry offer and going back to the lobby no
  longer costs you the way back in. The game's card under **Your tournaments**
  carries a **Re-enter** button for as long as the window is open, and one
  press puts you back at a table with a fresh stack rather than leaving you to
  guess that **Rejoin** was the way. The add-on is on the card the same way, so
  a player who steps out during the break can still take it.
- A seat that goes without a hand to explain it is now said over the felt for a
  few seconds, not only written into the dealer's log: a player forfeiting, and
  a player the host removes. The log opens on Chat, so a seat could simply
  vanish between hands with nothing anyone saw to account for it.
- Somebody watching after their own game ended is counted on the rail. The Info
  tab's Rail line only ever counted people who arrived by the rail link, so a
  busted player watching the table showed up nowhere.
- The bubble no longer says "hand for hand" at a final table. Holding a table
  until the others have finished is a thing you do to a field spread over more
  than one table; with one table left there is nobody to wait for, so the
  bubble is announced on the felt and in the Info tab without it. Nothing
  about the waiting itself changes while there is more than one table.
- The banner over the felt no longer loses the end of a long line. It is held
  to the lane between the two top chairs and its lines did not wrap, so a break
  saying where play resumes, and the bubble badge, ran off the end: past the
  badge's own background the text was dark on a dark felt, and "3 left, 2 paid"
  simply stopped after "2 p". The lines fold now, and each number stays with
  the word it belongs to.
- The Watch button on a running game's lobby card no longer sits on top of the
  button beside it. Join late and Watch were drawn in the same place, so the
  way into a game with late registration open was covered by the way to the
  rail.

## 0.10.0 - 2026-09-12

### Added

- Re-entry. A host can allow it when the game is made: none, or through
  level 1, 2, 3, 4 or 6, with the break after that level included, like late
  registration. A player who busts while it is open is offered Re-enter in
  the bust-out dialog and in the Info tab, and comes back with a fresh
  starting stack at the table with the fewest players, as many times as it
  takes while the window is open. Each re-entry pays the buy-in into the
  prize pool; the bust-out is struck from the standings, so the places paid
  still follow the number of people while the pool follows the entries.
- The add-on: one starting stack more, once, during the first break, for
  another buy-in into the pool. A host switches it on at creation, and only
  when the structure has a break to offer it at. During that break a seated
  player takes it from the Info tab; asked for while the table is still
  finishing a hand, it lands when the hand does.
- The waiting room's settings line and the lobby card say whether a game has
  re-entry and the add-on; the Info tab's Field section shows entries beside
  players when they differ. A game that asks for neither is a freezeout, as
  every game was before.
- On a break the felt is cleared, once the last hand's result has had a few
  seconds, and the middle of the table reads On break with the clock to the
  end of it and the blinds play resumes at. Paused during a break, it says so.

## 0.9.0 - 2026-09-11

### Added

- Watching a table. Every game has a rail link, a second code that is a way
  to look and never a way in: the people in a game find it beside Copy link
  in the waiting room and as Copy rail link in the Info tab, and a public
  game's card has a Watch button while it runs. Opening the link, after
  giving a name, puts you at the table as a watcher: the same view a busted
  player gets, with nobody's cards until they are shown, no seat and no
  action bar, the banner, the Info tab with a Watching block to switch
  tables, and the table's chat, where your lines carry a rail badge. The
  people in the game see "N watching" in the Info tab. A watcher is never on
  the roster, never the host, never handed the join code, does not hold a
  game open, and is forgotten by a restart; the link brings them back. Up to
  fifty per game.
- A busted player can switch which table they watch, from the same block.
- The bot box goes up to forty: the eight named donkeys, then the rest drawn
  from a longer list, so one person can raise a field of several tables.

### Changed

- The dealer's log and the table's chat are separate tabs. Chat, still first
  and still where the box is, holds only what people say, and lights up when
  somebody talks; the new Log tab beside it holds the hand's narration, a
  few hands deep, without a conversation pushing it out of view. The strip
  over the felt still repeats the last line of either.
- A busted player can now talk at the table they watch, marked rail, and the
  host can mute them like anyone else. Before, they could only read.
  Reactions stay with seats: nobody without a chair can throw one.

## 0.8.0 - 2026-09-11

### Added

- The host's controls at the table, in the Info tab while the game runs:
  Pause and Resume (the hand in play finishes, no table deals, and the blind
  clock stands still), a level back or forward, a minute on or off the level
  in play, Move to… to send a player to a smaller table, and Remove, which
  takes a player's stack out of play, finishes them in the place they hold
  at that moment (paid if that place pays), sends them to the lobby and does
  not let them back in. The banner reads Paused and the lobby card says
  paused. A host cannot remove themselves, and cannot move a player to a
  table that would leave the tables more than a seat apart.

- The create form's bot box takes a count, one to eight, rather than always
  five. Eight bots and a host at 8-max is a full table; at 4-max it is three
  tables, which is what the host's Move to… needs.

### Fixed

- Two tables that never rested at the same moment never merged, and could
  stay a seat or more apart: each finished a hand, found the other dealing,
  and dealt itself another. Six players sat on two tables of three at 6-max
  for fourteen hands. A table the field is waiting on, the one due to break
  or the one due to give a player up, now sits out a hand so the move can be
  made, and a field with nothing dealing settles itself without waiting for
  a hand to end.

### Changed

- A paused game with nobody connected is kept for thirty minutes rather than
  two before it is cleared, since a pause is when people walk away.
- A level change, the clock's or the host's, reaches the felt at once rather
  than with the next hand.

## 0.7.0 - 2026-09-11

### Added

- A blind structure to choose when a game is made: Turbo, Standard or Deep,
  or Edit levels and set every level's blinds, ante, length and breaks by
  hand. The waiting room says which and lists the whole ladder before anyone
  sits down, the lobby card names it, and the table's Info tab shows it with
  the level the clock is on.
- Antes. From the level the structure says, the big blind posts an ante equal
  to the big blind straight into the pot, before the blind; a short stack
  covers the ante first. The chat says who posted it, the banner and the Info
  tab show it, and the hand history keeps it.
- Breaks. A structure can carry breaks; when one arrives the hand in play
  finishes, no table deals until it is over, the banner reads Break with the
  blinds play resumes at, and late registration through a level stays open
  through the break after it.
- A chime on every level change, breaks included.

### Changed

- A new game runs Standard unless the host picks otherwise: eighteen levels
  from 10/20 to 3000/6000, antes from level 6 and a break after levels 6 and
  12, in place of the fixed thirteen. The first six levels are the ones the
  old ladder had. The level length chosen at creation is still the length of
  every level, breaks included, unless the host edits one.
- Level numbers count levels of play, so a break never takes a number; and
  the final level no longer counts down to a level that does not come.

## 0.6.0 - 2026-09-11

### Added

- The host reads and talks at every table. In a field of more than one table
  the host's Chat tab gets a strip, All and one pill per table: pick a table
  to read what is said there and answer it, pick All to say something to
  every table at once. An announcement lands in each table's chat marked as
  the host's and "to all tables", and flashes over the felt for a few seconds
  so a closed panel is not a missed break call. The host hears every table
  live, keeps the floor after busting, and everyone else's chat is exactly as
  it was: a line said at a table reaches that table, and the host.

## 0.5.0 - 2026-09-11

### Added

- The Operator page lists every game on the server, listed or not: its state,
  its code, who is connected, how many are at the door of an invite-only game,
  and an End game button for each. The lobby list and `GET /api/tournaments`
  are unchanged; this is behind the operator password, on the socket that
  unlocked it.

### Fixed

- A phone that had FinalTable open since before an update was running the old
  page against the new server: a knock on an invite-only game reached the host,
  but the phone showed nothing, because its scripts had never heard of the
  event. The page now notices the server has moved on and reloads itself, from
  the lobby right away and from a table once you leave it (a notice at the top
  says so meanwhile, and tapping it reloads at once). The one page that
  predates this needs one reload by hand.

## 0.4.0 - 2026-09-10

### Added

- A game is now private unless you say otherwise. Private means unlisted: it is
  not on the lobby list or the public API, and the only way in is the code or
  the link, which is what a group passes around anyway. Public puts it on the
  list for anyone to join, as every game used to be. Invite-only is unlisted
  too, and the link lets somebody ask rather than walk in: they wait at the
  door while the host sees them in the waiting room, or on the table's Info tab
  once the cards are out, and lets them in or turns them away. A request
  survives a short drop and lapses after a minute away; a game that is
  cancelled or closes late registration tells whoever was still waiting. The
  choice is made when the game is created and cannot be changed after. Games
  saved before this come back private.

### Changed

- `GET /api/tournaments` lists public games only. An unlisted game answers
  "Tournament not found" to its id without its code, so the lobby cannot be
  used to guess at one.

## 0.3.0 - 2026-09-10

### Added

- Reactions. A strip of six emoji beside the arm-a-line buttons, for the seat
  whose turn it is not: one tap and it floats up from your chair on every
  screen at the table, then goes. It is chat with the words taken out - the
  same room, the same host mute, the same people - and none of chat's record:
  nothing is written to the log, nothing comes back on a reload. Three a
  minute per player, tighter than chat because a tap is cheaper than a
  sentence. Under reduced motion it appears in place rather than floating.
  `REACTIONS_ENABLED=false` removes the strip and the event; `REACTION_RATE`
  and `REACTION_RATE_WINDOW_MS` tune the limit.

## 0.2.0 - 2026-09-10

### Added

- Sign in with GameNight. A server paired with a GameNight site (three new
  settings: `GAMENIGHT_URL`, `GAMENIGHT_AUDIENCE`, `GAMENIGHT_PUBLIC_KEY`, see
  `.env.example`) shows a button beside the name box. It sends you to GameNight
  to sign in there, two-factor and all, and brings you back seated under your
  GameNight username: the name is GameNight's and cannot be edited here, the
  avatar is still yours, and the roster marks you as a GameNight player. The
  same account is the same player on every device, and a join link followed
  before signing in still lands at its table afterwards. Sign out from the
  same row. Guests are unchanged, and a server that is not paired has no
  button. Known limit: a guest and a GameNight member with the same name still
  cannot share a tournament; the second to arrive is refused as before.
- The operator password can be changed from the Operator page, which is the
  last thing there that needed a shell and a restart. It asks for the current
  one first (a tab left open is not proof of who is at it), wants at least
  eight characters, and signs out every other operator session, since whoever
  is being locked out is usually the reason for changing it. What is stored is
  a scrypt hash in `data/settings.json`, never the password. `ADMIN_PASSWORD`
  still gives a server its first one - with no password there is no operator
  surface and so no way in to set one - and after a change the stored one wins.
  Forgotten it: remove `adminPassword` from `data/settings.json` and the one in
  the environment works again.
- An Operator page in the lobby, behind the admin password, where the
  GameNight pairing is made: enter the GameNight address and the app slug, and
  the signing key is fetched from it, nothing to paste. Refresh it after
  GameNight rotates its key, or unpair; the sign-in button follows without a
  restart, and the pairing survives one. The environment variables still work
  and seed the page the first time a server boots without a saved pairing;
  after that the page wins.
- Chat. Players at the same table can talk to each other, and everyone in the
  waiting room can talk before the cards are out - it hands over to the table
  you are seated at once the tournament starts. The last hundred lines of a
  room come back after a reload, a rejoin, being moved to another table, or a
  server restart.
- The host can mute a player from the waiting-room roster, and unmute them
  again. A muted player is told why rather than typing into nothing.
- A message also surfaces as a small bubble over the chair of whoever said it,
  for a few seconds, so a line is noticed without looking away from the felt
  or opening the panel. The panel is still the record.
- Chat can be turned off for the whole server with `CHAT_ENABLED=false`, which
  removes the surface rather than hiding the box. `CHAT_HISTORY`,
  `CHAT_MAX_LEN`, `CHAT_RATE` and `CHAT_RATE_WINDOW_MS` tune what is kept and
  how fast anyone can talk.

### Changed

- The lobby has a menu in the top corner. Operator was a small grey link under
  the tournament list, easy to miss and only there on the first screen; signing
  out of GameNight was a button in the identity card, next to a name it was not
  really about. Both now live behind one button that stays in the corner while
  the list scrolls, along with a line naming the version, which the lobby never
  showed at all. It is the menu the table already has, in the same place.
- The server is deployed by pulling this repository on the host and restarting,
  rather than by building an image elsewhere and shipping the whole thing over
  SSH. The working tree is bind-mounted into the container, so nothing is built
  on a box that has no room to build, a rollback is a `git checkout`, and the
  deploy is two commands. `docker-compose.prod.yml` carries the host's own
  settings. See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

- The Chat tab no longer scrolls itself to the bottom while you are reading
  back through it, and keeps 200 lines rather than 50 - a conversation and the
  dealer's narration now share the pane.
- A player who busts can still read their table's chat, but not post to it.
- Only players still in the tournament can talk once it is running.

### Fixed

- The bubble saying what a player just did no longer sits on the felt after the
  moment has passed. It cleared on a three-second rule that was only ever
  checked when new state arrived, so on a table waiting for one player it
  stayed for as long as they took to act, and a raise from before the flop was
  still hanging over a chair with the flop on the board. It now goes when the
  next street is dealt, all-in runouts included, and otherwise fades out on its
  own three seconds after the action, whether or not anything else happens.
- A `.env` the server could see but not read stopped it booting, in a loop,
  rather than being skipped. It is what a deployment that mounts the working
  tree into the container does with a secrets file that is deliberately
  readable only by its owner; everything in it arrives through the environment
  anyway.
- A dialog raised while the lobby was showing was drawn underneath it, where it
  could be neither read nor dismissed. Everything the lobby had to tell you went
  unseen: that a tournament was cancelled, that the name was taken, that the one
  you were in had ended, and what became of your stack when you left a table.
- A tournament whose field could not be restarted is now held as it stood,
  with its chips, until the host starts or cancels it. It used to be dealt
  again from scratch a second later - a new table at level one with starting
  stacks, and again on every restart after that - which threw away the field
  the hold exists to keep.
- A running tournament brought back after a server restart is now cleared
  after the usual two minutes if none of its players return, the same as one
  everybody has disconnected from. Before, it was only ever cleared on a
  disconnect, and a field that came back with nobody in it had none coming -
  so it dealt to empty seats indefinitely, and showed in the lobby as running.
- The lobby list, and `GET /api/tournaments` behind it, no longer carry each
  game's join code. Anyone who could reach the server could read every code
  and walk into any game; now the code is only shown in the waiting room of a
  game you are in. Joining from a lobby card still works - it goes by the
  game rather than the code - and the code box and `?t=` links are unchanged.

- A deploy could leave a browser on the previous build until someone thought to
  hard-refresh. The page carries the cache-busting stamp for every script and
  stylesheet, but was itself served without a cache header, so a browser was
  free to hold a stale copy and keep asking for the old files.

### Removed

- The 3D room behind the felt, and the 589 KB WebGL library that drew it -
  larger on its own than everything else a browser downloads for this. It
  rendered flat black over a CSS background that already had the lit room in
  it, so desktop was getting the worse of the two. That CSS background is now
  simply the background, which is what phones have always had.

## 0.1.9 - 2026-09-09

The first entry, covering everything since FinalTable forked from LONICERA on
5 September 2026. Summarised rather than itemised - it is five days and a
hundred-odd commits, and the ones before this line were made without a
changelog to write into.

### Added

- Multi-table tournaments. A director runs one field across as many tables as
  it needs, carrying chips between them under a conservation invariant, on one
  blind clock. Tables balance and break as players bust, and the field merges
  down to a final table.
- Payouts, the money bubble, and hand-for-hand play once it arrives.
- A tournament lobby. An identity that survives a reload, scheduled starts,
  joining by code or by link, late registration, and a waiting room showing the
  roster as it fills.
- Rejoin. A dropped connection or a page reload puts a player back in their
  seat. Registrations survive a server restart, and so does a running field: it
  is recorded between hands, never during one, and seated again on the way back
  up.
- A rebuilt table screen. A stage beside a docked side panel that becomes a
  drawer on a phone, seat plates, bets on the felt, a pot above the board, and
  Chat, Info, Stats and History tabs. The dealer narrates into Chat.
- Eight fixed chairs, and a right-click - long press on touch - that turns the
  table so you are sitting in the one you picked.
- Movement and sound. Chips fly seat to pot and pot to winner, the board turns
  over rather than sliding in, hole cards are dealt from the button one at a
  time, and the deck is shuffled as each hand starts. Recorded samples for
  chips, cards and the check knock. Mute lives in the table menu and is
  remembered.
- A turn clock drawn as an outline round the hole cards: green, pulsing amber
  at fifteen seconds, pulsing red with one audible warning at nine.
- Raise sizing presets on the action bar, priced off the pot, on phones as well
  as desktop.
- A line you can arm before the turn reaches you, resolved at the price the
  table actually got to.
- Request Time, once per hand.
- The five cards that make a hand, lit at showdown and named on the control
  bar. Every winner's share is stated, so a side pot stops looking like a
  mistake.
- Hands turned face up when the betting is over and the board still has to run
  out, street by street.
- A result screen when the tournament ends, for the winner and for everyone
  else.
- Five demo seats behind a checkbox on the create form, so one person can fill
  a table and watch it play. They are donkeys on purpose.
- Operator controls behind a password, including stopping a tournament that is
  already running.
- A measured capacity figure in the README, and the two settings a reverse
  proxy needs.

### Changed

- Seats deal clockwise, matching the direction of play.
- Eight seats to a table. It went to ten briefly and came back once the felt
  was laid out for eight.
- A seat is sat out after two timeouts in a row, not one. Losing a hand to a
  moment of inattention is a fair price; losing the tournament to it is not.
- Less waiting between hands and between streets.
- Host authority resolves through a stable player id rather than a display
  name.
- Broadcasts got cheaper: the roster goes out once for the whole field, a push
  stopped costing the square of it, and hand history stopped riding along with
  every bet.
- The identity store writes off the hot path.
- The licence dropped upstream's appended anti-gambling restriction. See
  FORK.md.
- Node base image moved from 18, which is end of life, to 22.

### Fixed

- A human could not act in a multi-table tournament.
- Seats hung off the screen on portrait iPads and large phones, and a two-line
  name plate landed on its neighbour.
- Refreshing mid-hand put the viewer in the wrong chair and left the animations
  out of step until the next showdown.
- The action bar resized under the pointer between hands and while dragging the
  slider, and its controls could overlap.
- The turn clock appeared to start several seconds late, because the client was
  measuring an absolute server time against its own.
- Mute only covered a quarter of the sounds, and a parked audio context was
  lost for the rest of the session rather than woken by the next gesture.
- The replay handed out cards nobody had shown.
- A player who left the table could not get back to it.
- The big blind gets its option back.
- Folding a hand that costs nothing to see asks first.

### Removed

- The bots and the whole solver tree, about 6,300 lines and seven test suites,
  along with the equity helper and the single-table room layer that depended on
  them. A seat playing itself is now a sit-out: it checks when that is free and
  folds to a bet, and never puts chips in on an absent player's behalf. See
  FORK.md, which also covers why demo seats came back without reversing this.

---

Note on tags: this repository has none yet. `v1.0.1` was a local leftover from
the fork - upstream LONICERA's release, on upstream's repository - and has been
removed. FinalTable's own numbering is 0.1.x and starts here.
