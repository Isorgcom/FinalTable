# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅ Yes    |

## Reporting a Vulnerability

If you discover a security vulnerability in FinalTable, **please do not open a public issue**.

Instead, please report it privately:

1. **GitHub Security Advisory or maintainer email**: Use the private reporting channel listed by the repository owner.
2. **Include**: A description of the vulnerability, steps to reproduce, and potential impact.

We will acknowledge your report within **48 hours** and aim to provide a fix within **7 days** for critical issues.

## Security Architecture

FinalTable is designed for **self-hosted, private network** deployment (home NAS, LAN parties). It is **not hardened for public internet exposure** without additional protections.

### Current Security Measures

- **Dependency-free HTTP security headers** (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`)
- **Device tokens** (24 random bytes, base64url) are a player's only credential; the uid in rosters and game state proves nothing. A local account's token is minted when its name and password go together; a GameNight player's token is minted after a signed sign-in token is verified (below). Either way every browser they sign in from gets one of its own on the same identity, and every one of them can be ended from the Users page
- **GameNight sign-in tokens** are ES256 JWTs verified locally with GameNight's public key (`server/gamenight-sso.js`): algorithm pinned (`none` and HS256 refused before the signature is read), issuer and audience matched, two-minute lifetime with a ten-minute ceiling, and a `jti` replay set so a token is good once. The token arrives in the URL fragment, so it reaches no access log or Referer, and the page scrubs it. The client also carries a random `state` through the round trip against login CSRF. No password, email or phone ever reaches this server. Sign-out is per browser: GameNight ends a device signed in here with `POST /api/players/:user_id/sign-out`; a logout on its own site reaches this server only if it calls that. The pairing itself (`server/gamenight-pairing.js`) is one of the server's two outbound HTTP calls (the webhooks below are the other): a GET of GameNight's `/api/v1/sso`, made only when an admin who has unlocked the admin controls asks for it, with an 8-second timeout, and the answer is accepted only if it carries a P-256 key; the admin can point it at any http(s) address, which is the trust the admin password already implies
- **The admin surface belongs to an account**, not to a password. A socket is an administrator because the account that identified on it carries the role, which is read once at identify and settled nowhere else, so it survives a reconnect, cannot be guessed, and is per person rather than per server. Taking it away reaches the browser the person is holding. The first account made on a fresh server gets the role; an existing server with nobody marked says so at boot and is given one by name with `ADMIN_PROMOTE`, which is also the way back in when the only administrator is lost — set it, **restart**, and the account is an administrator from then on. `CLAIM_TOKEN` is the third way and the one a fresh server is meant to use: a boot-time secret of at least sixteen characters (shorter is refused at boot and logged), offered from the sign-in card only while no administrator exists, compared in constant time, behind the same per-socket window and delay as a wrong password, refused and logged on a mismatch, and inert the moment there is an administrator. There is no `ADMIN_PASSWORD`; a server that still sets one is told at boot that it does nothing, and any password stored from the old Admin page is cleared

- **The API key** is how GameNight proves it is GameNight when it makes a game here (`docs/API.md`). Made by an administrator on the Admin page, 32 random bytes, shown once and never again; what is kept is a SHA-256 digest, compared in constant time, so the database does not hold the key. It is a bearer token on the `/api/games` routes - making a game, reading it, and the host's controls over it - and on one `/api/players` route, and nothing else; its authority reaches identities in one way, ending a GameNight player's sessions here, which is what GameNight's own logout could not do before, behind the same per-address rate limit as the rest of `/api`; there is one, making another replaces it, and revoking it leaves none. A refused request is logged with the address it came from and never with what it sent. A game it makes is invite-only with a guest list; somebody off the list who presents the code is told so, and an id without the code still gets "Tournament not found", so a guess learns nothing
- **Webhooks** go out to an address the API-key holder named for one game (`docs/API.md`), carrying no secret and signed with HMAC-SHA256 over the timestamp and the body, so the receiver can tell a delivery from a forgery and, by the delivery id, from a replay. Each attempt has an 8-second timeout, a redirect is not followed, and nothing is sent for a game made without one. The signing secret is held in plaintext - on the game's row while it exists and in the outbox for a week after the last delivery - for the SMTP password's reason: it has to be replayed. It never reaches a browser, a log line or the admin Log; what the API answer carries is the address and how the deliveries stand
- **The SMTP password and a game's webhook secret are the secrets kept recoverably.** Everything else
  this server holds is hashed (passwords) or digested (device tokens), so a
  stolen copy of the database is not a stolen set of credentials — with these
  exceptions, because a mail password has to be replayed to the mail host and
  a webhook has to be signed, and neither can be hashed. It is in the `settings` table as given, which means it
  is in any `mysqldump`, any replica, and readable by anyone with the database
  password or a shell on that container. The mitigations are that the database
  publishes no port, has its own volume and its own credentials, and that the
  Admin page never sends the password back to a browser — not even as a hash,
  because a hash of a password is a thing to attack offline at leisure. What
  the page is told is whether one is stored and when it was set. Anything the
  mail server says back is run through a redactor first, because an SMTP error
  quotes what it was given more often than anybody expects and that answer
  reaches both a browser and the admin Log
- **A game reports only where this server expects to report.** The address on
  `POST /api/games` used to be taken as given, so whoever held the API key
  could aim this server's POST at any host it could route to and read the
  result back through `GET /api/games/:id` - a port scanner, built out of two
  documented features. Since 0.26.1 the address must be the paired
  GameNight's origin or one named in `WEBHOOK_ORIGINS`, compared scheme, host
  and port exactly, on the way in **and** on the way back from disk. A server
  with neither refuses the webhook and says so. What comes back through the
  API about a failure is two states - could not be reached, or answered an
  error - while the admin Log keeps the errno, the status and the timeout an
  operator actually needs
- **The Mail page's test button makes an outbound connection to a host an
  administrator names**, as the GameNight pairing does. It is behind
  the administrator role, rate-limited to three a minute per socket, carries
  its own short timeouts, and sends only to the address on the administrator's
  own account — never to one typed into the form, which is what stops it being
  a small open relay
- **Passwords** are scrypt (N=16384, r=8, p=1) with a salt of its own per record, hashed and compared off the event loop, and never logged. An administrator's is an account password like anybody else's. Signing in answers the same sentence to a wrong password and to a name with no account, so the answer is never a list of who plays here
- **Hole cards never leave the server for anyone but their owner.** `getStateForPlayer()` in `engine.js` builds every player's view separately and puts a seat's cards in it only when the viewer is that seat, or the hand is face up (showdown, or an all-in run-out with the betting finished); every other seat's `holeCards` is `null` in the payload, not hidden client-side. `__tests__/engine.test.js` walks those exposure rules. The shuffle is a Fisher-Yates over `crypto.randomInt` (`deck.js`, `random.js`), not `Math.random`
- **A game is unlisted unless its host makes it public.** The lobby list and `GET /api/tournaments` carry public games only; a private or invite-only game reaches only the lists of its own members, and an id presented without its code gets "Tournament not found" rather than any hint the game exists. Invite-only adds a door: a request to join is held in memory only (never on disk), capped at fifty per game, and is not a registration, an entrant, a chat member or a vote toward anything until the host lets it in
- **The host hears every table** in their own game: their socket is a recipient of every table room's chat, and `to` on a chat line (a table number or `all`) is honoured for the host only and ignored from anyone else. A host who busts keeps the floor; the mute still cannot be turned on the host, and nobody else's room membership changes
- **The rail is a second secret, and a way to look only.** Every game carries a rail code beside its join code; a rail link never seats anyone, and `join` by code is the only way in. A watcher is held in memory only (never on disk), capped at fifty per game, is not an entrant, a registration, a candidate for host or a vote toward keeping a game alive, and is a member of exactly one chat room, the table they watch, where their lines are marked as from the rail and the host's mute applies. A watcher's state omits the join code, and the table view they receive is the same per-viewer build as any seat's: an id that matches no seat gets no hole cards until a hand is face up. A game that is unlisted is reached by its rail code or not at all; only a public game can be watched by id
- **The admin's list** (`adminListTournaments`) is the one place an unlisted game and its code are shown to someone not in it: behind the administrator role, answered only on that socket, never broadcast. The admin runs the machine and holds `data/tournaments.json` already, so this is a window, not a door
- **Input validation** on all Socket.IO handlers (type checking, length limits, regex, enumerations)
- **Frontend DOM rendering** uses DOM builders and `textContent` for user-controlled content instead of HTML string injection
- **Rate limiting** on API endpoints (240 req/min/IP by default) and WebSocket events (30 events/sec/client)
- **WebSocket connection limit** (200 concurrent connections)
- **Atomic file writes** for save data (tmp + rename pattern)
- **Room count limit** (50 rooms max) to prevent memory exhaustion
- **Configurable CORS and deployment limits** via environment variables
- **Non-root Docker user** (`USER node`)

### Known Limitations

- The deal is not verifiable by a player, only by reading the code. There is no commitment to the shuffled deck published at the deal and revealed after the hand, so a player takes the server's word that the cards that came out were the cards that were dealt. That is on the [roadmap](./ROADMAP.md) under "Trust, but verify"

- No TLS termination built-in — use a reverse proxy (nginx, Caddy, Traefik) for HTTPS
- No HSTS or `upgrade-insecure-requests` header by default, so LAN/NAS HTTP deployments keep working
- No default CSP header yet; the current frontend has been cleaned up substantially, but the project still prefers a simple self-hosted default over shipping a strict policy that may surprise NAS/LAN deployments
- No database — game state is in-memory, saves are JSON files
- Single-process architecture — no horizontal scaling

### Recommended Deployment

```
[Internet] → [Reverse Proxy (TLS)] → [FinalTable container (port 2026)]
```

For public-facing deployments, always:

1. Use a reverse proxy with TLS (e.g., Caddy, nginx + Let's Encrypt)
2. Restrict access via firewall or VPN (Tailscale, WireGuard)
3. Set `CORS_ORIGIN` to your specific domain
