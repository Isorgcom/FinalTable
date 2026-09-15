const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// Anything that wants to see what is logged, as well as the console. Module
// level rather than per-logger on purpose: a logger is made once per scope at
// require time, and a subscriber registered afterwards still has to hear from
// all of them. It is what lets the admin log keep every warning and error
// without a line at any of the places that raise one - including the ones
// nobody has written yet.
const sinks = [];

function onEntry(fn) {
  if (typeof fn !== 'function') return () => {};
  sinks.push(fn);
  return () => {
    const i = sinks.indexOf(fn);
    if (i >= 0) sinks.splice(i, 1);
  };
}

function createStructuredLogger(scope, configuredLevel = process.env.LOG_LEVEL || 'info') {
  return ({ level = 'info', event, roomId, message, data = {} }) => {
    if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < (LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.info))
      return;

    const entry = {
      ts: new Date().toISOString(),
      scope,
      level,
      event,
      roomId,
      message,
      ...data,
    };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    // After the console, and never allowed to stop it: a subscriber that
    // throws must not take the log line with it.
    for (const sink of sinks) {
      try {
        sink(entry);
      } catch (_err) {
        /* a listener is not worth losing a log line over */
      }
    }
  };
}

module.exports = { createStructuredLogger, onEntry };
