// webhook-origins.js - where a game may report to.
//
// A game made over the API names the address its events are sent to. Until
// 0.26.1 that could be any host this server could route to: the address was
// checked for being an http(s) URL and nothing else. The key that names it is
// the administrator's own, so this was never a way in - but "make and drive
// games" is not "post to anything on my network", and the delivery's own
// error came back through `GET /api/games/:id`, which turned the pair into a
// port scanner for whoever held the key.
//
// So an address must now be one this server was told to expect: the GameNight
// it is paired with, or one the operator listed in WEBHOOK_ORIGINS. A server
// with neither has nowhere a webhook may be sent, and says so rather than
// making a game that quietly reports into the dark.
//
// The comparison is the origin - scheme, host and port, exactly - which is
// what the sign-in bridge already does with a return address on GameNight's
// side. A path is not part of it: GameNight's receiver may live anywhere on
// its own host.

// The origin of an http(s) address, or null for anything else. `URL.origin`
// leaves a default port off, so http://x and http://x:80 compare equal, which
// is the answer a person would give.
function originOf(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch (_err) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

// The list an address is measured against, from the pairing and the operator's
// own. Deduplicated and in a stable order so a refusal reads the same twice.
function allowedOrigins({ pairing = null, extra = [] } = {}) {
  const out = [];
  const add = (value) => {
    const origin = originOf(value);
    if (origin && !out.includes(origin)) out.push(origin);
  };
  if (pairing) {
    // Both, because they can differ: `url` is what the administrator typed,
    // `issuer` is what GameNight calls itself at /api/v1/sso.
    add(pairing.url);
    add(pairing.issuer);
  }
  for (const value of extra || []) add(value);
  return out;
}

// null or undefined means no rule - the unit tests' default, and the shape a
// caller that has not been taught about origins still gets. An empty list is
// a rule: nowhere is allowed.
function webhookAllowed(url, origins) {
  if (!origins) return true;
  const origin = originOf(url);
  return !!origin && origins.includes(origin);
}

// What to say when it is refused. The address is never echoed back - a
// refusal should not confirm what was probed.
function refusalFor(origins) {
  if (!origins || !origins.length) {
    return 'This server has no paired GameNight, so a webhook has nowhere it may be sent.';
  }
  if (origins.length === 1) return `The webhook url must be at ${origins[0]}.`;
  return `The webhook url must be at one of: ${origins.join(', ')}.`;
}

module.exports = { originOf, allowedOrigins, webhookAllowed, refusalFor };
