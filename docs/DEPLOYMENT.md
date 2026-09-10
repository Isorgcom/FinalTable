# Deploying

Two places this runs, and they update differently. There is no deploy script:
the server side is three commands, and a script wrapping them turned out to be
more moving parts than the thing it wrapped.

## The server

The box carries no source and never builds. It is a 1 vCPU VPS with a few
hundred megabytes free running other things beside this one, and `npm ci` there
is slow at best and takes the neighbours down at worst. So the image is built
on a machine with room, and only the finished image travels:

```bash
docker build -t finaltable:latest .
docker save finaltable:latest | gzip -1 | ssh root@HOST 'gunzip | docker load'
ssh root@HOST 'cd /opt/finaltable && docker compose up -d'
```

Then check it actually came up, which the commands above will not tell you:

```bash
curl -s https://your-host/api/status      # {"activeTournaments":0}
ssh root@HOST 'docker ps --filter name=finaltable --format "{{.Status}}"'
```

`gzip -1` rather than the default because the image is mostly incompressible
layers already, so the time is all in the transfer.

Three things to know:

- **`docker compose up -d`, never `docker restart`.** Restart starts the _same
  container_, which is still pointed at the old image, so the deploy silently
  does nothing and looks like it worked.
- **The whole image goes over the wire every time**, around 250 MB. The far
  side already has most of those layers and `docker save` has no way to know
  it. A registry would send only what changed; this trades that away for having
  no registry to run.
- **There is no rollback.** Every build overwrites `finaltable:latest`, which
  is the only tag the server has, so the previous image is gone once the new
  one lands. Build with `-t finaltable:$(git rev-parse --short HEAD)` as well
  if you want something to fall back to.

Commit before building. Nothing enforces it, and an image built from a dirty
tree matches no commit, which is unpleasant to work out later from the server.

### What the host needs

- Docker, and an SSH key
- A compose file naming `image: finaltable:latest` rather than a `build:`
  block, since there is no source there to build from. Everything else can be
  copied from the compose file in the repository root.
- Its own `.env`, holding that machine's settings and admin password

Nothing secret is sent. The image carries no configuration, so the same one is
fine on a public box and a private one.

### Sizing it

Set `NODE_HEAP_MB` and `MEM_LIMIT` together; raising one alone only changes
which limit is hit first. A busy box wants _less_ than the repository default
of a 384 MB heap in a 512 MB container, not more. The Capacity section of the
[README](../README.md) has the measured numbers.

## The development clone

A clone used for development bind-mounts the working tree into the container,
so the server reads files straight off disk:

```yaml
volumes:
  - .:/app
  - /app/node_modules
```

Which makes an update a pull and a restart, with no build at all:

```bash
git pull --ff-only origin main
docker restart finaltable-dev
```

A rebuild is only needed when `package.json` or the `Dockerfile` changes, since
`node_modules` lives in an anonymous volume rather than in the tree.

That clone keeps its own `docker-compose.yml` - different container name,
different published port, debug logging - and it is a permanent local
divergence, never mirrored from the repository. A pull must not clobber it.

## The data outlives the image

Tournaments, identities and chat live in a named volume at `/app/data`, not in
the image, so replacing the image keeps the field that was playing. A running
tournament is recorded between hands and seated again on the way back up.

## Running it somewhere else

Anyone self-hosting on a machine with room to build needs none of the above -
clone the repository and use the compose file directly, as the
[README](../README.md) describes:

```bash
docker compose up -d --build
```
