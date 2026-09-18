// mailer.js - the two messages this server sends.
//
// Both are links, and both are only ever sent to an address somebody typed
// into the lobby themselves: one to prove that address at sign-up, one to set
// a new password. Nothing else is ever sent to anybody.
//
// Three ways this can be set up.
//
//   SMTP_URL, and a PUBLIC_URL to build links against, is the real one.
//   MAIL_TRANSPORT=log writes the message and its link to the server log
//     instead of sending it, which is how development and the tests exercise
//     the whole flow without a mail server.
//   Neither means no mail, which means no accounts. The lobby says so rather
//     than offering a password box that cannot deliver.
//
// nodemailer is required lazily, so a server with no mail configured never
// loads it and the tests never need it.

function createMailer(options = {}) {
  const {
    smtpUrl = '',
    from = '',
    baseUrl = '',
    transport = '',
    log = () => {},
    appName = 'FinalTable',
  } = options;
  const logging = String(transport).toLowerCase() === 'log';
  let base = String(baseUrl || '').replace(/\/+$/, '');
  let sender = null;

  // A server only learns the address it came up on after it has come up, and a
  // test picks its port at random. PUBLIC_URL is the answer in production -
  // behind a proxy the socket's own address is the wrong one - and this is for
  // the case where it is not known until then.
  function setBaseUrl(url) {
    base = String(url || '').replace(/\/+$/, '');
    return base;
  }

  // Links have to be absolute and they have to be right: one that lands on the
  // wrong host is a sign-up nobody can finish.
  function available() {
    return !!base && (logging || !!smtpUrl);
  }

  function why() {
    if (!base) return 'PUBLIC_URL is not set, so a link in an email would point nowhere.';
    if (!logging && !smtpUrl) return 'SMTP_URL is not set, so this server cannot send mail.';
    return null;
  }

  function link(route, token) {
    return `${base}/${route}?token=${encodeURIComponent(token)}`;
  }

  function transporter() {
    if (sender || logging) return sender;
    // Required here rather than at the top: a server with no mail set up never
    // loads it at all.
    const nodemailer = require('nodemailer');
    sender = nodemailer.createTransport(smtpUrl);
    return sender;
  }

  function send({ to, subject, text }) {
    if (!available()) return Promise.resolve(false);
    if (logging) {
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
      .sendMail({ from: from || `${appName} <no-reply@localhost>`, to, subject, text })
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

  return { available, why, sendVerification, sendReset, link, setBaseUrl, logging };
}

module.exports = { createMailer };
