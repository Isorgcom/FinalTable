// mailer.js - the two messages this server sends.
//
// Both are links, and both are only ever sent to an address somebody typed
// into the lobby themselves: one to prove that address at sign-up, one to set
// a new password. Nothing else is ever sent to anybody.
//
// Three ways this can be set up.
//
//   A mail server and a public address to build links against is the real
//     one. Both are set from the Admin page and kept in the database; the
//     environment seeds them on a first boot and is not consulted again.
//   Writing the message and its link to the server log instead of sending it,
//     which is how development and the tests exercise the whole flow without
//     a mail server.
//   Neither means no mail, which means nobody can sign up. The sign-in screen
//     says so rather than offering a form that cannot deliver.
//
// Every one of those can change while the server is running, which is why the
// settings are an object here rather than the closed-over consts they used to
// be: configure() replaces them and drops the memoised transport, so the next
// message goes wherever it was just told.
//
// nodemailer is required lazily, so a server with no mail configured never
// loads it and the tests never need it.

function createMailer(options = {}) {
  const { log = () => {}, appName = 'FinalTable' } = options;

  // Everything that can be set from the Admin page, in one object rather than
  // as closed-over consts. It used to be the latter, which meant a server
  // could only be told where to send at the moment it started - the reason
  // these settings lived in a file nobody could reach from a browser.
  const current = {
    baseUrl: '',
    from: '',
    transport: '',
    // Either shape reaches nodemailer: a URL, which is what the environment
    // has always carried, or the fields, which is what the page collects.
    // The fields are preferred where both are set, because a URL cannot hold
    // a password containing @ : / or # without escaping it first, and an
    // admin typing one into a form has no reason to know that.
    smtpUrl: '',
    host: '',
    port: 0,
    secure: true,
    user: '',
    pass: '',
  };
  let sender = null;

  // The one place the settings move, so the memoised transport cannot outlive
  // the settings it was built from.
  function configure(next = {}) {
    for (const key of Object.keys(current)) {
      if (next[key] === undefined) continue;
      current[key] = key === 'port' ? Number(next[key]) || 0 : next[key];
    }
    current.baseUrl = String(current.baseUrl || '').replace(/\/+$/, '');
    // Closed rather than dropped. Nothing here pools connections today, so a
    // dropped one is collected soon enough - but the day anybody sets
    // pool: true, a settings change would leak a socket per save.
    if (sender && typeof sender.close === 'function') {
      try {
        sender.close();
      } catch (_err) {
        /* a transport that will not close is not worth failing a save over */
      }
    }
    sender = null;
    return current;
  }

  configure(options);

  // A server only learns the address it came up on after it has come up, and a
  // test picks its port at random. PUBLIC_URL is the answer in production -
  // behind a proxy the socket's own address is the wrong one - and this is for
  // the case where it is not known until then.
  function setBaseUrl(url) {
    configure({ baseUrl: url || '' });
    return current.baseUrl;
  }

  const logging = () => String(current.transport).toLowerCase() === 'log';
  const hasServer = () => !!current.host || !!current.smtpUrl;

  // Links have to be absolute and they have to be right: one that lands on the
  // wrong host is a sign-up nobody can finish.
  function available() {
    return !!current.baseUrl && (logging() || hasServer());
  }

  function why() {
    if (!current.baseUrl) {
      return 'There is no public address for a link in an email to point at.';
    }
    if (!logging() && !hasServer()) return 'No mail server is set, so nothing can be sent.';
    return null;
  }

  function link(route, token) {
    return `${current.baseUrl}/${route}?token=${encodeURIComponent(token)}`;
  }

  // The fields where they are set, the URL where they are not. Only ever read
  // through transporter(), so there is one place a stale transport could come
  // from and it is cleared by configure().
  function transportOptions() {
    if (current.host) {
      const port = current.port || (current.secure ? 465 : 587);
      const options = { host: current.host, port, secure: !!current.secure };
      if (current.user) options.auth = { user: current.user, pass: current.pass };
      return options;
    }
    return current.smtpUrl;
  }

  function transporter() {
    if (sender || logging() || !hasServer()) return sender;
    // Required here rather than at the top: a server with no mail set up never
    // loads it at all.
    const nodemailer = require('nodemailer');
    sender = nodemailer.createTransport(transportOptions());
    return sender;
  }

  // Open the connection and sign in, without sending anything to anybody.
  // What the Admin page's Test connection asks, and the honest answer to "are
  // these settings right" - a send would also prove it and would put a message
  // in somebody's inbox to do it.
  //
  // Answers { ok } or { ok: false, error }, never throwing: the caller is a
  // socket handler and the error is for a person to read.
  function verify() {
    if (logging()) {
      return Promise.resolve({ ok: true, logged: true });
    }
    if (!hasServer()) return Promise.resolve({ ok: false, error: 'No mail server is set.' });
    return Promise.resolve()
      .then(() => transporter().verify())
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: (err && err.message) || 'That did not work.' }));
  }

  function send({ to, subject, text, needsLink = true }) {
    // A message carrying a link needs somewhere for it to point; one that
    // carries none only needs a way out.
    if (needsLink ? !available() : !logging() && !hasServer()) return Promise.resolve(false);
    if (logging()) {
      // The whole message, link and all. This is a development transport and
      // the log is the inbox; it is never on in a server that can send.
      log({
        level: 'info',
        event: 'mail_logged',
        message: 'Mail written to the log instead of sent',
        data: { to, subject, text },
      });
      return Promise.resolve(true);
    }
    return transporter()
      .sendMail({ from: current.from || `${appName} <no-reply@localhost>`, to, subject, text })
      .then(() => true)
      .catch((err) => {
        // Never the address and never the body: a failure is worth knowing
        // about and is not worth writing somebody's mail into the log.
        log({
          level: 'warn',
          event: 'mail_failed',
          message: 'Could not send mail',
          data: { subject, detail: err && err.message },
        });
        return false;
      });
  }

  function sendVerification({ to, name, token }) {
    return send({
      to,
      subject: `${appName}: finish setting up ${name}`,
      text: [
        `Somebody asked to keep the name ${name} on ${appName}.`,
        '',
        'If it was you, open this once to finish:',
        link('verify', token),
        '',
        'The link lasts a day. If it was not you, nothing has happened and you',
        'can ignore this.',
      ].join('\n'),
    });
  }

  function sendReset({ to, name, token }) {
    return send({
      to,
      subject: `${appName}: a new password for ${name}`,
      text: [
        `Somebody asked for a new password for ${name} on ${appName}.`,
        '',
        'If it was you, open this once to set one:',
        link('reset', token),
        '',
        'The link lasts an hour and works once. If it was not you, your',
        'password has not changed and you can ignore this.',
      ].join('\n'),
    });
  }

  // One message to one address, so an administrator can prove delivery as
  // well as connection. Answers the same shape verify() does.
  //
  // Deliberately not gated on available(), which wants a public address
  // because the two real messages carry links. This one carries none, and an
  // admin who has filled in a mail server but not yet a public address should
  // be told that rather than told the message did not go.
  function sendTest({ to }) {
    if (!to) return Promise.resolve({ ok: false, error: 'No address to send it to.' });
    if (!logging() && !hasServer()) {
      return Promise.resolve({ ok: false, error: 'No mail server is set.' });
    }
    return send({
      to,
      needsLink: false,
      subject: `${appName}: a test message`,
      text: [
        `This is ${appName} checking that it can send mail.`,
        '',
        'Somebody pressed the button on the Admin page. If you were not',
        'expecting it, somebody who administers that server was.',
      ].join('\n'),
    }).then((sent) =>
      sent ? { ok: true, logged: logging() } : { ok: false, error: 'The message did not go.' }
    );
  }

  return {
    available,
    why,
    configure,
    verify,
    sendTest,
    sendVerification,
    sendReset,
    link,
    setBaseUrl,
    logging,
  };
}

module.exports = { createMailer };
