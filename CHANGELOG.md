# Changelog

What changed in FinalTable, newest first. This is the player's and the
operator's view: what behaves differently, not how it was built. For lineage
and what the fork removed from upstream see [FORK.md](./FORK.md); for the
reasoning behind any one change, the git history says more than a line here
can.

Entries are grouped as Added, Changed, Fixed and Removed, roughly following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
[semver](https://semver.org/), and a version heading means a `v*` tag and a
Release on GitHub to go with it.

## Unreleased

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

### Fixed

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

### Removed

- The 3D room behind the felt, and the 589 KB WebGL library that drew it -
  larger on its own than everything else a browser downloads for this. It
  rendered flat black over a CSS background that already had the lit room in
  it, so desktop was getting the worse of the two. That CSS background is now
  simply the background, which is what phones have always had.

### Fixed

- A deploy could leave a browser on the previous build until someone thought to
  hard-refresh. The page carries the cache-busting stamp for every script and
  stylesheet, but was itself served without a cache header, so a browser was
  free to hold a stale copy and keep asking for the old files.

### Changed

- The Chat tab no longer scrolls itself to the bottom while you are reading
  back through it, and keeps 200 lines rather than 50 - a conversation and the
  dealer's narration now share the pane.
- A player who busts can still read their table's chat, but not post to it.
- Only players still in the tournament can talk once it is running.

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
