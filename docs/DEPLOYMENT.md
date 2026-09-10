# Deploying

The server carries a clone of this repository and reads its source straight off
disk, so a deploy is a pull and a restart. There is no deploy script: it is two
commands, and a script wrapping them turned out to be more moving parts than
the thing it wrapped.

## The server

```bash
ssh root@HOST
cd /opt/finaltable
git pull --ff-only origin main
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart
```

Then check it actually came up, which those will not tell you:

```bash
curl -s https://your-host/api/status      # {"activeTournaments":0}
ssh root@HOST 'docker ps --filter name=finaltable --format "{{.Status}}"'
```

**Nothing is built.** The box is a 1 vCPU VPS with a few hundred megabytes free
running other things beside this one, and `npm ci` there is slow at best and
takes the neighbours down at worst. It does not have to: `docker-compose.prod.yml`
bind-mounts the working tree into the container, so the source that runs is the
source in the clone, and `node_modules` stays in the image where it was built.
This is how GameNight serves `www/` on the same host.

Three things to know:

- **The restart is not optional.** `public/index.html` is templated once per
  process with the asset version, and every module is loaded at boot, so a pull
  on its own changes nothing a player can see. Only CSS and images are live.
- **A rebuild is only needed when `package.json` or the `Dockerfile` changes.**
  Then, and only then:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
  ```
  On this host that is worth doing at a quiet hour, or on a machine with room
  (`docker build -t finaltable:latest .` there, then
  `docker save finaltable:latest | gzip -1 | ssh root@HOST 'gunzip | docker load'`).
- **Rolling back is `git checkout`**, which is most of the reason for deploying
  this way. Any commit or tag, then restart; the image is not involved.

Commit and push before pulling. Nothing enforces it, and a server sitting on a
commit that exists nowhere else is unpleasant to work out later.

### What the host needs

- Docker, `git`, and an SSH key
- A read-only **deploy key** for this repository, since it is private. Generate
  one on the server, add the public half under Settings › Deploy keys, and give
  it a host alias so the remote stays readable:
  ```
  # ~/.ssh/config
  Host github-finaltable
      HostName github.com
      User git
      IdentityFile ~/.ssh/finaltable_deploy
      IdentitiesOnly yes
  ```
  then `git clone github-finaltable:OWNER/FinalTable.git /opt/finaltable`.
- Its own `.env` beside the compose files, holding that machine's admin
  password and any sizing. It is gitignored, so a pull never touches it.

The clone is the deployment. `docker-compose.prod.yml` is committed and carries
this host's specifics: the bind mount, the proxy network, `TRUST_PROXY`, and
memory sized for a box that has other tenants.

### Pairing with GameNight

Optional. Paired, the lobby offers "Sign in with GameNight" next to the guest
name box, and a player who signs in there is seated here under their GameNight
username with no second account. Three steps, once per server, all from a
browser:

1. In GameNight, as a site admin, open Site Settings > Connected Apps and add
   this server: a slug (`finaltable`), a name, and the base URL players use to
   reach it. The URL must match exactly, scheme, host and port: it is the only
   place GameNight will ever send a token.
2. In this server's lobby, open **Operator** (the small link under the list;
   it needs `ADMIN_PASSWORD` set) and enter the GameNight address and the slug.
   The signing key is fetched from GameNight, checked, and saved to
   `data/settings.json`; the button appears for everyone at once.
3. If GameNight ever regenerates its key, press **Refresh key** on the same
   page. **Unpair** takes the button away again.

Only the public key travels, and only this way round. GameNight signs each
sign-in with a private key it never shares, so this server can check a token
on its own and a leak here lets nobody forge one. The key id shown on the
Operator page matches the one on GameNight's Connected Apps page.

When both run on the same host, the address to enter can be the internal one -
`http://gamenight`, the container's name on the proxy network - rather than the
public URL. What is stored as the issuer is whatever GameNight calls itself in
its answer, not what was typed, so the tokens still verify against its public
name. That also sidesteps a host whose NAT will not let a container reach its
own public address.

The three environment variables (`GAMENIGHT_URL`, `GAMENIGHT_AUDIENCE`,
`GAMENIGHT_PUBLIC_KEY`, see `.env.example`) still work for a headless setup:
they seed the pairing the first time a server boots with nothing saved, and
after that the saved pairing wins, so a change made on the Operator page is
not undone by a restart.

### Sizing it

Set `NODE_HEAP_MB` and `MEM_LIMIT` together; raising one alone only changes
which limit is hit first. A busy box wants _less_ than the repository default
of a 384 MB heap in a 512 MB container, not more, which is why
`docker-compose.prod.yml` asks for 256 in 384. The Capacity section of the
[README](../README.md) has the measured numbers.

## The development clone

A clone used for development bind-mounts the working tree the same way, and so
updates the same way:

```bash
git pull --ff-only origin main
docker restart finaltable-dev
```

That clone keeps its own `docker-compose.yml` - different container name,
different published port, debug logging - and it is a permanent local
divergence, never mirrored from the repository. A pull must not clobber it.

## The data outlives everything

Tournaments, identities, chat and the GameNight pairing live in a named volume
at `/app/data`, not in the image and not in the clone, so neither a pull nor a
rebuild touches the field that was playing. A running tournament is recorded
between hands and seated again on the way back up.

## Running it somewhere else

Anyone self-hosting on a machine with room to build needs none of the above -
clone the repository and use the compose file on its own, as the
[README](../README.md) describes:

```bash
docker compose up -d --build
```
