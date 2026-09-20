# The API

What GameNight calls to make a game on this server and to read it back while
it runs. Two routes, one caller, one key. Everything a player does goes over
the socket; this is the machine's door.

## The key

An administrator makes it on the Admin page, under **GameNight**, with **Make
a key**. It is shown once. Paste it into GameNight's Connected Apps entry for
this server; from then on GameNight sends it on every call:

```
Authorization: Bearer <key>
```

There is one key. **Make a new key** replaces it - the old one stops working
the moment the new one is made - and **Revoke** leaves none, which stops
GameNight until another is made. What this server keeps is a digest of the
key, never the key, so a copy of the database is not a copy of the key.

`GET /api/tournaments` takes a different credential - a player's device
token - and is a different door; the two do not meet.

## The envelope

Every answer is JSON, in GameNight's own shape:

```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": "A sentence saying what was wrong." }
```

| status | when                                                                 |
| ------ | -------------------------------------------------------------------- |
| 201    | the game was made                                                    |
| 200    | the game was read                                                    |
| 400    | the body could not be read; `error` says which field                 |
| 401    | no key on this server, or the wrong one; the sentence says which     |
| 404    | no game by that id                                                   |
| 409    | the host is already in a game, or the server holds as many as it may |
| 429    | too many requests from one address; `Retry-After` says when          |

Requests under `/api` are rate limited per address, 240 a minute by default
(`HTTP_RATE_LIMIT`, `HTTP_RATE_WINDOW_MS`).

## `POST /api/games`

Makes a game. The body is JSON, up to 64 KB, and is understood in two
vocabularies - GameNight's, and the one this server's own create form sends.
Where both are given, GameNight's wins.

| GameNight                         | this server                 | notes                                                                                                       |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `title`                           | `name`                      | up to 24 characters; `Tournament` if missing                                                                |
| `start_at` (ISO-8601)             | `startsAt` (ms since epoch) | up to seven days out, or 400; missing or past means now                                                     |
| `seats_per_table`, `poker_seats`  | `tableSize`                 | 2-8, default 8                                                                                              |
| `starting_chips`                  | `startChips`                | one of 1000, 2000, 5000, 10000 - anything else becomes 5000                                                 |
|                                   | `levelDuration` (s)         | 30-3600, default 300; a level without its own duration takes this                                           |
|                                   | `lateRegLevels`             | 0-8, default 3                                                                                              |
|                                   | `reentryLevels`             | 0-8, default 0 (a freezeout). Re-entry here is a window of levels, not a count, so `max_rebuys` is not read |
| `addon_allowed`                   | `addOn`                     | only takes if the structure has a break                                                                     |
| `buyin_amount`, `poker_buyin`     | `buyIn`                     | 0-10000                                                                                                     |
| `blind_levels` + `structure_name` | `structure`                 | see below                                                                                                   |
| `invitees`                        | `roster`                    | see below                                                                                                   |
|                                   | `bots`                      | 0-40 seats the server plays, for trying it out                                                              |

`visibility` is ignored: a game with a roster is invite-only, and the roster
is the door.

**The blinds.** `blind_levels` is GameNight's own list of rows -
`{ small_blind, big_blind, ante, duration_minutes, is_break }` - and comes
across as it is, minutes to seconds. `structure` is this server's shape: a
preset key (`turbo`, `standard`, `deep`) or `{ name, levels: [{ sb, bb,
ante, duration, break }] }`. Either is clamped the way the create form's
editor is: up to 60 levels, a break never first or doubled, an empty list
falls back to Standard.

**The roster.** One to two hundred people, each a GameNight user:

```json
{ "user_id": 7, "username": "Ann", "manager": true }
```

`user_id` is GameNight's numeric id - the `sub` its sign-in token carries -
and `username` the name. Exactly one row is the `manager` (or `host`), and
they host the game: the table controls are theirs, and if they never arrive
the title passes to whoever did, after the usual grace. Every person on the
roster is made known to this server before the game exists, so their seat is
waiting when they sign in through GameNight; a name somebody here already
has is worn with a number, as at the door.

The roster is the game's **guest list**. Anybody on it who opens the link,
or finds the game on their lobby list, walks straight in - no host approval.
Anybody else who presents the code is told they are not on the list. An id
without the code gets the answer any unlisted game gives, "Tournament not
found", so a guess learns nothing.

```bash
curl -s -X POST https://finaltable.example/api/games \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
    "title": "Thursday",
    "start_at": "2026-09-24T19:00:00Z",
    "seats_per_table": 8,
    "starting_chips": 5000,
    "blind_levels": [
      { "small_blind": 25, "big_blind": 50, "ante": 0, "duration_minutes": 15, "is_break": 0 },
      { "small_blind": 50, "big_blind": 100, "ante": 0, "duration_minutes": 15, "is_break": 0 },
      { "small_blind": 0, "big_blind": 0, "ante": 0, "duration_minutes": 10, "is_break": 1 },
      { "small_blind": 100, "big_blind": 200, "ante": 200, "duration_minutes": 15, "is_break": 0 }
    ],
    "invitees": [
      { "user_id": 7, "username": "Ann", "manager": true },
      { "user_id": 12, "username": "Bob" }
    ]
  }'
```

The answer, `201`:

```json
{
  "ok": true,
  "data": {
    "id": "t_3f9a1c2b4",
    "code": "K7PQ2",
    "rail": "M4XZ9",
    "name": "Thursday",
    "status": "registering",
    "visibility": "invite",
    "createdAt": 1790000000000,
    "startsAt": 1790400000000,
    "startedAt": null,
    "finishedAt": null,
    "host": { "uid": "gn_7", "name": "Ann" },
    "roster": [
      { "uid": "gn_7", "name": "Ann" },
      { "uid": "gn_12", "name": "Bob" }
    ],
    "entrants": [
      {
        "uid": "gn_7",
        "name": "Ann",
        "connected": false,
        "chips": 5000,
        "table": null,
        "place": null,
        "isBot": false,
        "isHost": true
      }
    ],
    "settings": {
      "tableSize": 8,
      "startChips": 5000,
      "levelDuration": 900,
      "structure": "Custom",
      "lateRegLevels": 3,
      "reentryLevels": 0,
      "addOn": false,
      "buyIn": 0
    },
    "level": 0,
    "paused": false,
    "remaining": 1,
    "prizePool": 0,
    "winner": null,
    "links": {
      "join": "https://finaltable.example/?t=K7PQ2",
      "rail": "https://finaltable.example/?w=M4XZ9"
    }
  }
}
```

`code` is the way in and `rail` the way to watch; `links` are those against
the public address the Mail tab holds, and `null` until it has one - the
game exists either way, and GameNight knows this server's address from its
own record. `entrants` is who has a seat: at creation, the host alone. The
roster is who may take one.

Two rules that bite. A game whose start passes with fewer than two people in
it is written off half an hour later, "nobody else came" - so a start far in
the future is refused rather than silently moved, and one that is near should
have a second person by then. And the host cannot be given a second game
while the first exists: that answers 409.

## `GET /api/games/:id`

The same `data` as above, as things stand now: `status` is `registering`,
`running` or `finished`; `entrants` carries `connected`, `chips`, `table` and
`place` for everybody with a seat; `level`, `paused`, `remaining`,
`prizePool` and `winner` say how it is going.

A finished game answers for as long as this server keeps it - ten minutes by
default (`TOURNAMENT_FINISHED_TTL_MS`) - and is then a 404. The final
standings are the webhook's business, when there is one; until then, read
the game inside that window.

## Not here yet

Cancel, pause and end from GameNight's side; the events this server would
send back - a bust-out, a re-entry, a level, the final table. See the
[roadmap](../ROADMAP.md).
