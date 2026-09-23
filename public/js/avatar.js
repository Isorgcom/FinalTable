// avatar.js - drawing a person.
//
// A player is one of two things here: an emoji they picked at this server's
// sign-in card, or a photograph they uploaded to the GameNight this server is
// paired with. The second arrives as a site-relative path on the sign-in
// token - never as image data, and never as a whole URL - so the origin is
// composed here, at the last possible moment, from the pairing the server is
// telling the browser about right now. Unpair a GameNight and the faces go
// with it; pair a different one and they come back, without a reload.
//
// One function, because there are six places that draw a person and the field
// changed shape under all of them: the seat plate, the waiting room roster
// twice, the admin people list, and the two lines that used to read
// "Playing as 🧑 Bryce" as a sentence.
const Avatars = (function () {
  // The paired GameNight's origin, told by lobby.js on every serverInfo.
  // Empty means nothing is paired, which is the same as nobody having a photo.
  let origin = '';

  function setOrigin(value) {
    origin = typeof value === 'string' ? value : '';
  }

  // A path the paired GameNight would have written, and nothing else. The
  // server checks this too, on the way in; this is the second half of the same
  // rule, because a client that trusted the field could be pointed at any
  // origin by a game state it did not author.
  function photoFor(who) {
    if (!origin || !who || typeof who.avatarPath !== 'string') return '';
    if (!/^\/uploads\/(avatars\/u\d+_)?[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(who.avatarPath)) {
      return '';
    }
    return origin + who.avatarPath;
  }

  // The emoji, for a place that is building a sentence rather than a box. A
  // string cannot hold a picture, so this is always an emoji.
  function emoji(who, fallback) {
    return (who && who.avatar) || fallback || '🧑';
  }

  // Fill `el` with somebody's face: the photograph if there is one, otherwise
  // the emoji they picked, otherwise the fallback this caller wants (the
  // roster says 🤖 for a bot where the seat plate says 🧑).
  //
  // The error handler is not optional. A GameNight that is down, a photo
  // deleted since the token was signed, a pairing pointing somewhere this
  // browser cannot reach - without it the seat shows an empty circle, which
  // reads as a bug rather than as a fallback.
  function render(el, who, fallback) {
    if (!el) return;
    const text = emoji(who, fallback);
    const src = photoFor(who);
    // The emoji goes in first and stays there when there is no photo. Blanking
    // the element and returning early left every seat with an empty circle.
    el.textContent = text;
    el.classList.toggle('has-photo', !!src);
    if (!src) return;
    el.textContent = '';
    const img = document.createElement('img');
    img.className = 'avatar-photo';
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      el.textContent = text;
      el.classList.remove('has-photo');
    });
    img.src = src;
    el.appendChild(img);
  }

  // A fresh element for a caller that is building a row rather than filling a
  // box it already has.
  function element(className, who, fallback) {
    const el = document.createElement('span');
    el.className = className;
    render(el, who, fallback);
    return el;
  }

  return { setOrigin, render, element, emoji, photoFor };
})();
