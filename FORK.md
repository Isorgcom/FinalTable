# Fork notice

**FinalTable** is a fork of [LONICERA](https://github.com/Evostructs/LONICERA)
(originally published as `BillWang0101/LONICERA`).

- Fork point: `012da2f9d21a5dc05087bd02841c25456d730e2b` ("Remove temporary GHCR cleanup workflow")
- Forked: 2026-09-05
- Upstream licence: GNU GPL v3.0, with an appended anti-gambling restriction
  that this fork has since removed. See "Licence" below.

Upstream is dormant: created 13 April 2026, last commit 24 April 2026, one
contributor. This fork does not expect to merge upstream changes back or to
receive any.

## Why this fork exists

LONICERA is an excellent single-table poker engine, but it is single-table by
design: 8 seats by default, and its tournament mode is a Sit-and-Go with a blind
clock and no concept of a second table. FinalTable adds multi-table tournament
play: seating a field across N tables, balancing and breaking them as players
bust, and merging to a final table.

## Changes from upstream

Phase 1:

- Removed 9 unreachable modules, the `scripts/`, `ai/`, `data/solver/` and
  `docs/experimental/` trees, and 11 tests that covered them. All of it was
  offline solver tooling that no runtime path reaches. About 6,500 lines.
- Kept the NPC decision path intact, on the grounds that bots were what made
  it practical to simulate a full field in tests without twenty-four humans.
- Default table size raised from 8 to 10 seats.
- Node base image moved from 18 (end of life) to 22.
- Renamed the package and replaced the container and compose definitions.

Phase 2:

- Removed the bots, reversing the Phase 1 decision above. FinalTable is a game
  between friends; a poker AI is not what it is for, and the bots were also
  playing the stacks of people who had merely lost signal. Gone: `npc.js` and
  its companions, every `solver-*` module, `strategy.js`, `veteran.js`, the
  preflop tables, `range.js` and `player-stats.js`, about 6,300 lines and
  seven test suites. Auto-play for a disconnected seat is now a plain sit-out
  that checks when free and folds to a bet.
- Removed the felt's Monte Carlo equity helper, which shared its simulation
  code with the bot decision path.
- Retired the single-table room layer (`server/socket-handlers.js`,
  `save-manager.js`, `server/host-manager.js`), unreachable from the lobby
  since the tournament rewrite and bot-dependent throughout.
- A tournament now needs two people before it can deal.

## Relationship to GameNight

None. FinalTable is a wholly separate project with its own repository,
containers, volumes and release cadence. It may be served from a subdomain of
gamenight.poker, but it shares no code, database or authentication with it, and
neither imports from the other.

## Licence

FinalTable is under the GNU GPL v3.0. `LICENSE` now carries the full text of it,
which it previously did not: the file held only the title, the preamble and a
link to gnu.org, and section 4 requires that a copy of the License be given to
every recipient, not a pointer to one.

Upstream appended an "ADDITIONAL RESTRICTION — ANTI-GAMBLING CLAUSE" to that
file, forbidding use for real-money gambling and terminating rights on breach.
It has been removed.

The reason is that the GPL does not permit it. Section 7 allows extra terms of
six enumerated kinds — warranty disclaimers, preserved attributions, marking
modified versions, trademark limits, declining trademark grants, indemnity — and
a restriction on the field of use is none of them. Of anything else it says:
"All other non-permissive additional terms are considered 'further restrictions'
within the meaning of section 10. If the Program as you received it, or any part
of it, contains a notice stating that it is governed by this License along with a
term that is a further restriction, you may remove that term." Section 10 says
plainly that no further restrictions may be imposed. The clause was also what
stopped this being open source in the ordinary sense: it fails the sixth point of
the Open Source Definition, which forbids discriminating against a field of
endeavour, and the first of the four freedoms, which is to run the program for any
purpose.

Upstream's copyright notice is retained, as sections 4, 5 and 7(b) require. Their
code is still theirs and still under the GPL; what changed is a term the GPL gave
every recipient leave to drop.

None of this touches gambling law. Whether a real-money game may be operated is a
question for the gambling regulator of the jurisdiction it runs in, and no licence
text moves that question in either direction.
