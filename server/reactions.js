// reactions.js - the few emoji a player can throw at the table without typing.
//
// A reaction is a chat message in everything but shape: it goes to the same
// room, past the same mute, to the same people. What it is not is a line in
// the log. It floats over the chair and is gone, because a busy table's chat
// would otherwise be a wall of claps with the conversation buried in it.
//
// The set is fixed, and small, and chosen here. An open picker would make
// this a second way to send a message, and messages have a place already.

const REACTIONS = ['👏', '😂', '😮', '😬', '🙄', '🔥'];

// Tighter than chat's, because a reaction costs one tap: four a minute is a
// person, twenty a minute is a thumb resting on the button.
const DEFAULT_RATE = 3;
const DEFAULT_WINDOW_MS = 10 * 1000;

function isReaction(value) {
  return typeof value === 'string' && REACTIONS.includes(value);
}

// A fixed window, the shape chat-rooms.js and http-middleware.js both use.
// The bucket lives on the socket, so it goes when the socket does.
function takeToken(
  bucket,
  { limit = DEFAULT_RATE, windowMs = DEFAULT_WINDOW_MS, at = Date.now() }
) {
  if (!bucket.reset || at >= bucket.reset) {
    bucket.count = 0;
    bucket.reset = at + windowMs;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

module.exports = { REACTIONS, isReaction, takeToken, DEFAULT_RATE, DEFAULT_WINDOW_MS };
