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
- **Device tokens** (24 random bytes, base64url) are a player's only credential; the uid in rosters and game state proves nothing. A guest's token is minted for the name they typed; a GameNight player's token is minted after a signed sign-in token is verified (below), and every browser they sign in from gets one of its own on the same identity
- **GameNight sign-in tokens** are ES256 JWTs verified locally with GameNight's public key (`server/gamenight-sso.js`): algorithm pinned (`none` and HS256 refused before the signature is read), issuer and audience matched, two-minute lifetime with a ten-minute ceiling, and a `jti` replay set so a token is good once. The token arrives in the URL fragment, so it reaches no access log or Referer, and the page scrubs it. The client also carries a random `state` through the round trip against login CSRF. No password, email or phone ever reaches this server. Sign-out is per browser: this server has no revoke yet, so a GameNight logout does not reach a device already signed in here. The pairing itself (`server/gamenight-pairing.js`) is the server's one outbound HTTP call: a GET of GameNight's `/api/v1/sso`, made only when an operator who has unlocked the admin controls asks for it, with an 8-second timeout, and the answer is accepted only if it carries a P-256 key; the operator can point it at any http(s) address, which is the trust the admin password already implies
- **Input validation** on all Socket.IO handlers (type checking, length limits, regex, enumerations)
- **Frontend DOM rendering** uses DOM builders and `textContent` for user-controlled content instead of HTML string injection
- **Rate limiting** on API endpoints (240 req/min/IP by default) and WebSocket events (30 events/sec/client)
- **WebSocket connection limit** (200 concurrent connections)
- **Atomic file writes** for save data (tmp + rename pattern)
- **Room count limit** (50 rooms max) to prevent memory exhaustion
- **Configurable CORS and deployment limits** via environment variables
- **Non-root Docker user** (`USER node`)

### Known Limitations

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
