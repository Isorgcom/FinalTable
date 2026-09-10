# Working on FinalTable

## Definition of done

A change is not finished until all of these are true:

1. `npm run lint`, `npm run format:check`, `npm test` and `npx playwright test`
   pass.
2. Anything a player or an operator would notice has a line in
   [CHANGELOG.md](./CHANGELOG.md) under `## Unreleased`, written in the same
   commit as the change itself.
3. Any document that now states the old behaviour is corrected: README.md for
   what the server does, FORK.md for what this fork did to upstream,
   CONTRIBUTING.md for how to work on it.

## The changelog

It is for the people who play on this server and the person who runs it, not
for whoever is reading the diff. Write what is different from the outside.

**Earns an entry:** anything visible at the table or in the lobby, a rule or a
timing change, a new setting or environment variable, a fix for something
somebody could have hit, a removal, a security or licence change.

**Does not:** refactors, renames, test-only work, formatting, dependency bumps
that change nothing observable. If the only honest sentence is "the code is
tidier now", it belongs in the commit message and nowhere else.

**How to write one.** One line, in the voice the commit messages use: plain,
concrete, and about the game rather than the code. Say what a player sees, not
which module changed: "a seat is sat out after two timeouts in a row, not one",
rather than "added `timeoutStrikes` to the player object". Group it under
Added, Changed, Fixed or Removed, and add the heading if that group is not
there yet.

## Cutting a release

1. Rename `## Unreleased` to `## X.Y.Z - YYYY-MM-DD` and open a fresh empty
   `## Unreleased` above it.
2. Match `version` in `package.json`.
3. Tag `vX.Y.Z`, push the tag, and publish a Release on GitHub with the notes
   from that heading. Nothing builds off the tag - deployment is a matter of
   getting an image onto a host over SSH, not of publishing one.

Semver against the players, not the API: a rule or a payout that behaves
differently is a minor, a fix is a patch. Stay on 0.x while this is under
active development; 1.0.0 is for when you would hand it to strangers. The
repository carries no tags yet - the `v1.0.1` that used to show up locally was
upstream LONICERA's, inherited by the fork, and has been removed.
