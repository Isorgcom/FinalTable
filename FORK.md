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
- Table size settled at 8 seats. It was briefly raised to 10, then brought
  back once the felt was laid out for eight: two seats across the top, two a
  side, two along the bottom, and the top and bottom centre lanes left clear.
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

Phase 3:

- Added five demo seats behind a checkbox on the create form, which is not a
  reversal of Phase 2. There is no poker AI here: `_donkeyMove` is thirty
  lines that call almost everything and raise half the pot at random, and it
  is reachable only when the person creating the tournament ticks the box.
  What Phase 2 removed was a bot playing a disconnected person's stack, and
  that stays removed - a sit-out is still a sit-out, and the two paths are
  separate in `processAutoTurn`. The demo seats exist so one person can see
  the table move without rounding up five friends first.

## Relationship to GameNight

Separate projects, deliberately, and staying that way. FinalTable has its own
repository, containers, volumes and release cadence, shares no code and no
database with GameNight, and neither imports the other. It may be served from a
subdomain of gamenight.poker; that is a DNS record, not a dependency.

What is planned is integration, not merging. The two talk over a signed token
today and will talk over an HTTP API and webhooks later - GameNight asks for a
game and is told when players bust and when it ends. The token is the sign-in
bridge: somebody logged into GameNight is seated here without a second account.
GameNight signs it with a key only GameNight holds, this server checks it with
the public half (`server/gamenight-sso.js`), and the player lands as a
GameNight identity in `server/identity.js` under their GameNight username. No
password, email or phone crosses. GameNight is the source of truth for who a
player is; it does not become part of this program. The boundary is the point:
either service can be down, or absent entirely, without taking the other with
it.

That is why standalone operation is a requirement rather than a fallback.
FinalTable must run for somebody who has never heard of GameNight - a guest
name, a join link, and a seat - and does: a server with no `GAMENIGHT_URL` has
no button, and a guest and a GameNight member sit at the same table.

See [ROADMAP.md](./ROADMAP.md) for the API, the events and the order of work.

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
