// mail-settings.js - where this server sends from, set from the Admin page.
//
// The same shape as the GameNight pairing beside it: one record, one place it
// changes, kept in the settings table, and an environment that seeds a first
// boot and is not consulted again. The saved record wins from then on, because
// somebody typed it into a browser and a stale line in a compose file should
// not undo that.
//
// What it drives is the live mailer rather than something it builds itself.
// apply() is the only thing that calls mailer.configure(), so there is one
// place where the settings and the transport built from them can disagree.
//
// Three modes rather than two flags. There used to be an SMTP URL and a
// separate "write it to the log instead" switch, and the switch silently won:
// a server seeded with the log transport would take a real mail server, say it
// had saved it, and send nothing for ever. On a page with a Save button that
// is not a trap worth keeping.
//
//   smtp  send it, through the server below
//   log   write it to the server's own log, link and all - for development
//   off   no mail, which means nobody can sign up
//
// The password is the one recoverable secret this server keeps. Everything
// else is hashed or digested; this one has to be replayed to the mail host, so
// it is stored as it was given. status() never returns it - not even as a
// hash, because a hash of a password is a thing to attack offline at leisure,
// and this one would be sent to a browser. What the page gets instead is
// whether one is stored and when it was set, which are the two questions
// somebody actually has.

const FIELDS = ['mode', 'publicUrl', 'from', 'host', 'port', 'secure', 'user', 'pass'];

function blank() {
  return {
    mode: 'off',
    publicUrl: '',
    from: '',
    host: '',
    port: 0,
    secure: true,
    user: '',
    pass: '',
    passSetAt: null,
    source: null,
    updatedAt: 0,
  };
}

function createMailRuntime(options = {}) {
  const { settingsStore = null, mailer = null, envSeed = null, log = () => {} } = options;

  let current = blank();

  // What the mailer is told, every time, every field. A partial configure
  // would leave the old SMTP URL behind it, and transportOptions() falls back
  // to that URL the moment a host is cleared - so a server switched from the
  // environment's settings to the page's would keep sending through the
  // environment's.
  function push() {
    if (!mailer) return;
    mailer.configure({
      // Only when there is one: the tests and a server behind a proxy set the
      // base after startup, and a saved record with no public address in it
      // must not blank what they set.
      ...(current.publicUrl ? { baseUrl: current.publicUrl } : {}),
      from: current.from,
      transport: current.mode === 'log' ? 'log' : '',
      smtpUrl: '',
      host: current.mode === 'smtp' ? current.host : '',
      port: current.port,
      secure: current.secure,
      user: current.user,
      pass: current.pass,
    });
  }

  // The single mutation point.
  //
  // The password merges rather than replaces: the page cannot show what is
  // stored, so it sends an empty box when nothing about it changed. An empty
  // string therefore means "leave it", and clearing one is its own flag.
  function apply(next = {}, { persist = true, source = 'gui' } = {}) {
    const merged = { ...current };
    for (const key of FIELDS) {
      if (next[key] === undefined) continue;
      if (key === 'pass') continue;
      merged[key] = key === 'port' ? Number(next[key]) || 0 : next[key];
    }
    if (next.clearPass) {
      merged.pass = '';
      merged.passSetAt = null;
    } else if (next.pass) {
      merged.pass = String(next.pass);
      merged.passSetAt = Date.now();
    }
    merged.mode = ['smtp', 'log', 'off'].includes(merged.mode) ? merged.mode : 'off';
    merged.source = source;
    merged.updatedAt = Date.now();

    current = merged;
    push();
    if (persist && settingsStore) settingsStore.set('mail', current);
    log({
      level: 'info',
      event: current.mode === 'off' ? 'mail_unconfigured' : 'mail_configured',
      message: 'Where this server sends from was set',
      // Never the password, and never the address it would be sent to.
      data: { mode: current.mode, host: current.host, port: current.port, user: current.user },
    });
    return current;
  }

  // The saved record if there is one, the environment's if there is not. The
  // seed is written down, so the next boot reads it as a saved record and the
  // environment stops mattering.
  function init() {
    const saved = settingsStore ? settingsStore.get('mail') : null;
    if (saved && saved.mode) {
      current = { ...blank(), ...saved };
      push();
      return current;
    }
    if (envSeed) return apply(envSeed, { persist: !!settingsStore, source: 'env' });
    push();
    return current;
  }

  // What the Admin page is told. Everything except the password, which is
  // replaced by the two facts about it that are safe to hand out.
  function status() {
    return {
      mode: current.mode,
      publicUrl: current.publicUrl,
      from: current.from,
      host: current.host,
      port: current.port,
      secure: !!current.secure,
      user: current.user,
      passSet: !!current.pass,
      passSetAt: current.passSetAt,
      source: current.source,
      updatedAt: current.updatedAt,
      envPresent: !!envSeed,
      available: mailer ? mailer.available() : false,
      why: mailer ? mailer.why() : null,
    };
  }

  // For the test button, which tries the form as typed rather than what is
  // saved - otherwise setting a mail server up is still guess, save, restart,
  // guess. Answers the settings to try, with the stored password filled in
  // when the box was left empty.
  function asTyped(next = {}) {
    const merged = { ...current };
    for (const key of FIELDS) {
      if (next[key] === undefined || key === 'pass') continue;
      merged[key] = key === 'port' ? Number(next[key]) || 0 : next[key];
    }
    merged.pass = next.pass ? String(next.pass) : next.clearPass ? '' : current.pass;
    return merged;
  }

  // Whatever is in a message the mail server sent back, with the password
  // taken out of it. An SMTP error quotes what it was given more often than
  // anybody expects, and this one goes to a browser and to the admin log.
  function redact(text) {
    const said = String(text || '');
    if (!current.pass) return said;
    return said.split(current.pass).join('***');
  }

  return { init, apply, status, asTyped, redact, get: () => current };
}

module.exports = { createMailRuntime };
