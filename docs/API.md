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
| `webhook_url` + `webhook_secret`  | `webhook: { url, secret }`  | where to send the game's events, and what to sign them with: both or neither; see Webhooks below            |
| `event_id`                        | `external_id`               | GameNight's own id for the event, up to 64 characters, echoed on every webhook                              |
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
    },
    "webhook": {
      "url": "https://gamenight.example/hooks/finaltable",
      "externalId": "ev_812",
      "deliveries": { "pending": 0, "delivered": 0, "abandoned": 0, "lastError": null }
    }
  }
}
```

`webhook` is where the game reports to and how that is going; it is `null`
for a game made without one, and never carries the secret.

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
standings arrive on the `tournament.completed` webhook, below; a game made
without one has to be read inside that window.

## Webhooks

A game made with a `webhook` reports back to it: every bust-out, every
re-entry, and the ending. Each is a `POST` of a JSON body to the address
given, signed with the secret given, and tried again for about a day if
GameNight does not answer.

### The request

```
POST <url>
Content-Type: application/json
User-Agent: FinalTable/0.24.0
X-FinalTable-Event: player.eliminated
X-FinalTable-Delivery: 41
X-FinalTable-Timestamp: 1790000000000
X-FinalTable-Signature: sha256=<hex>
```

The signature is HMAC-SHA256, keyed with the secret, over the timestamp, a
dot, and the body exactly as sent. Check it before reading anything, and
keep the delivery id: a retry carries the same `delivery_id` and a fresh
timestamp, so a delivery you have already handled is one to answer `200`
and drop.

```php
$ts   = $_SERVER['HTTP_X_FINALTABLE_TIMESTAMP'];
$sig  = $_SERVER['HTTP_X_FINALTABLE_SIGNATURE'];      // "sha256=<hex>"
$body = file_get_contents('php://input');
$want = 'sha256=' . hash_hmac('sha256', $ts . '.' . $body, $secret);
if (!hash_equals($want, $sig)) { http_response_code(401); exit; }
$event = json_decode($body, true);
// seen $event['delivery_id'] before? answer 200 and stop.
```

Any `2xx` counts as delivered. Anything else - another status, a redirect
(which is not followed), no answer within `WEBHOOK_TIMEOUT_MS` (8 seconds) -
counts as a failure, and the delivery is tried again after 1 minute, then 5,
30, 2 hours, 6, 12; after the seventh failure it is given up on, and the
admin Log says so. The first failure is in the Log too; the retries between
are not. Deliveries go in order per game - a game's second event waits for
its first - and a delivery given up on releases the ones behind it. What is
owed is kept in the database, so a restart in the middle loses nothing.

### The envelope

Every body carries the event, the delivery, when it was sent, and the game:

```json
{
  "event": "player.eliminated",
  "delivery_id": 41,
  "sent_at": 1790000000000,
  "game": { "id": "t_3f9a1c2b4", "name": "Thursday", "external_id": "ev_812" }
}
```

A player is named three ways: this server's `uid`, GameNight's `user_id`
(the `sub` its sign-in token carries, `null` for a bot), and the `name` as it
was at the table. Bots take places and are sent like anybody else, flagged
`is_bot`.

### `player.eliminated`

```json
{
  "player": { "uid": "gn_12", "user_id": "12", "name": "Bob", "is_bot": false },
  "place": 4,
  "prize": 0,
  "in_the_money": false,
  "final": false,
  "how": "busted",
  "remaining": 3,
  "entrants": 5,
  "at": 1790000000000
}
```

`how` is `busted`, `forfeit` (they conceded the seat) or `removed` (the host
took them out). **`place` and `prize` are provisional while `final` is
`false`**: until late registration and re-entry have both closed, a player
coming in behind them moves every place already handed out. Corrected
places are not re-sent; the `standings` on `tournament.completed` are the
last word.

### `player.reentered`

```json
{
  "player": { "uid": "gn_12", "user_id": "12", "name": "Bob", "is_bot": false },
  "reentries": 1,
  "remaining": 4,
  "entries": 6,
  "at": 1790000000000
}
```

The bust-out this undoes was sent; this is the correction. `entries` counts
everybody's entries, re-entries and add-ons together, which is what the
prize pool is built from.

### `tournament.completed`

```json
{
  "outcome": "winner",
  "winner": { "uid": "gn_7", "user_id": "7", "name": "Ann" },
  "standings": [
    {
      "place": 1,
      "uid": "gn_7",
      "user_id": "7",
      "name": "Ann",
      "is_bot": false,
      "prize": 350,
      "in_the_money": true,
      "reentries": 0,
      "add_on": false
    },
    {
      "place": 2,
      "uid": "bot:t_3f9a1c2b4:2",
      "user_id": null,
      "name": "Jenny",
      "is_bot": true,
      "prize": 150,
      "in_the_money": true,
      "reentries": 0,
      "add_on": false
    },
    {
      "place": 3,
      "uid": "gn_12",
      "user_id": "12",
      "name": "Bob",
      "is_bot": false,
      "prize": 0,
      "in_the_money": false,
      "reentries": 1,
      "add_on": true
    }
  ],
  "entrants": 3,
  "humans": 2,
  "entries": 5,
  "prize_pool": 500,
  "buy_in": 100,
  "level": 6,
  "hands": 87,
  "started_at": 1790000000000,
  "finished_at": 1790003600000
}
```

Every place, first to last; this is the record of the night.

### `tournament.cancelled`

```json
{
  "outcome": "cancelled",
  "reason": "cancelled by the host",
  "standings": [
    {
      "place": 5,
      "uid": "gn_31",
      "user_id": "31",
      "name": "Cy",
      "is_bot": false,
      "prize": 0,
      "in_the_money": false,
      "reentries": 0,
      "add_on": false
    }
  ],
  "entrants": 5,
  "started_at": 1790000000000,
  "ended_at": 1790001000000
}
```

`reason` is one of `cancelled by the host`, `cancelled by the admin`,
`nobody else came` (the start passed with fewer than two people), `nobody
came back` (everybody left and stayed gone), `halted` (the table could not
go on) or `empty`. `standings` is who had gone out by then; `started_at` is
`null` for a game that never dealt.

## Not here yet

Cancel, pause and end from GameNight's side; the blind-level event; a
heartbeat. See the [roadmap](../ROADMAP.md).
