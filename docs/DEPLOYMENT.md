# Deploying

Two places this runs, and they update differently.

## The server: ship.sh

The box carries no source and never builds. It is a 1 vCPU VPS with a few
hundred megabytes free, running other things beside this one, and `npm ci` on
it is slow at best and takes the neighbours down at worst. So the image is
built on a machine with room and only the finished image travels:

```bash
./ship.sh root@your-host            # or: ./ship.sh root@your-host /opt/finaltable
```

That builds the image, pipes it over SSH into `docker load`, recreates the
container, and waits for its healthcheck before reporting success - started and
working are not the same thing, and a process that exits four seconds after
boot otherwise looks like a good deploy.

It refuses to run with uncommitted changes, so what lands on the server always
matches a commit.

The host needs three things the script does not touch:

- Docker, and an SSH key you can log in with
- A compose file naming `image: finaltable:latest` rather than a `build:`
  block, since there is no source there to build from. Everything else can be
  copied from the compose file in the repository root.
- Its own `.env`, holding that machine's settings and admin password

Nothing secret is sent. The image carries no configuration, so the same one is
fine on a public box and a private one.

**Use `docker compose up -d`, never `docker restart`, after loading a new
image.** Restart starts the _same container_, which is still pointed at the old
image, so the deploy silently does nothing. That is the mistake ship.sh exists
to stop you making by hand.

### Sizing it

Set `NODE_HEAP_MB` and `MEM_LIMIT` together; raising one alone only changes
which limit is hit first. A busy box wants _less_ than the repository default
of 384 MB heap in a 512 MB container, not more. See the Capacity section of the
[README](../README.md) for what the numbers actually buy.

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
divergence that is never mirrored from the repository. A pull must not clobber
it.

## Checking it worked

`/api/status` answers with the number of running tournaments, which is the
cheapest proof it is really up:

```bash
curl -s http://127.0.0.1:8091/api/status
```

Tournaments and identities live in a named volume at `/app/data`, not in the
image, so replacing the image keeps the field that was playing. A running
tournament is recorded between hands and seated again on the way back up.

## Running it somewhere else

Anyone self-hosting on a machine with room to build does not need any of this -
clone the repository and use the compose file directly, as the
[README](../README.md) describes:

```bash
docker compose up -d --build
```
