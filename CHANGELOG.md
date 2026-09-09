# Changelog

What changed in FinalTable, newest first. This is the player's and the
operator's view: what behaves differently, not how it was built. For lineage
and what the fork removed from upstream see [FORK.md](./FORK.md); for the
reasoning behind any one change, the git history says more than a line here
can.

Entries are grouped as Added, Changed, Fixed and Removed, roughly following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
[semver](https://semver.org/), and a version heading means a `v*` tag, which is
what publishes a container image.

## Unreleased

Nothing yet.

## 0.1.0 - 2026-09-09

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

Note on tags: `v1.0.1` in this repository is upstream LONICERA's release,
inherited through the fork. FinalTable's own numbering starts at 0.1.0.
