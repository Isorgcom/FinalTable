# Deploying

The server carries a clone of this repository and reads its source straight off
disk, so a deploy is a pull and a restart. There is no deploy script: it is two
commands, and a script wrapping them turned out to be more moving parts than
the thing it wrapped.

## The database

FinalTable keeps what it knows in a MariaDB of its own, started beside the
server by the compose file. It is not shared with anything else on the host and
it publishes no port: the server reaches it by name on the network compose
makes, and a shell uses `docker exec`.

Two settings have no defaults, so `docker compose up` refuses rather than
bringing up a database anybody who has read the compose file could open:

```bash
cp .env.example .env
# set DB_PASSWORD and DB_ROOT_PASSWORD to something long
```

The schema is applied on every boot with `CREATE TABLE IF NOT EXISTS`, so a
fresh database becomes a working one by being started. Nothing here ever drops
or alters a table.

**Coming from a version that kept files.** The first boot that finds the tables
empty reads `data/*.json` in and renames each one `.imported` - never deletes
it. Device tokens become digests on the way through, which signs nobody out:
the browser still sends the token it has. Judged per file, so a later version
that adds a table imports only that one.

**Backing it up** is `mysqldump`, and `data/` no longer holds anything that
matters once the import has run:

```bash
docker exec finaltable-db mariadb-dump -ufinaltable -p"$DB_PASSWORD" finaltable > finaltable.sql
```

**What it costs.** MariaDB wants a couple of hundred megabytes on a box that
has a few hundred spare. The compose file sizes it small - a 32 MB buffer pool
on the production overlay, which holds this schema several times over - and
every number is an environment variable. If the box is tight, `DB_BUFFER_POOL`
and `DB_MEM_LIMIT` are the two to look at.

## The server

```bash
ssh root@HOST
cd /opt/finaltable
git pull --ff-only origin main
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`up -d` rather than `restart`: the database is a second container now, and a
restart of a stack that has gained a service does not start the new one.

The move onto a database is itself a `package.json` change - it added a MariaDB
client - so the deploy that brings it in is the rebuild case below, with
`--build --renew-anon-volumes`. After that, ordinary deploys are `up -d` again.

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
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --renew-anon-volumes
  ```

  `--renew-anon-volumes` is not optional, and leaving it off is a confusing
  half-hour. `node_modules` lives in an anonymous volume - that is what keeps
  the bind mount from hiding the image's copy - and an anonymous volume is
  **reused** when a container is recreated. So a rebuild that installs a new
  dependency succeeds, the container comes back, and the server crashes on
  `MODULE_NOT_FOUND` for a package that is plainly in the image: what it is
  actually reading is the old volume. Renewing it throws that away and takes
  the image's copy.

  On this host a build is worth doing at a quiet hour, or on a machine with
  room (`docker build -t finaltable:latest .` there, then
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
  Compose reads it on the host and passes the values in; the container sees the
  file too, through the bind mount, and skips it if the permissions say it is
  none of its business, so mode 600 is fine and is the point.

The clone is the deployment. `docker-compose.prod.yml` is committed and carries
this host's specifics: the bind mount, the proxy network, `TRUST_PROXY`, and
memory sized for a box that has other tenants.

### The admin password

`ADMIN_PASSWORD` in the host's `.env` is how a server gets its first one: with
no password there is no admin surface, and so no way in to set one. After
that it is changed from the **admin** page, reached from the menu in the
lobby's top corner, and the new one is
kept as a scrypt hash in `data/settings.json` and wins over the environment
from then on - a password somebody typed into a browser should not be undone
by a stale line in a compose file.

Forgotten it, remove `adminPassword` from that file and the environment's works
again:

```bash
docker exec finaltable node -e 'const f="/app/data/settings.json",fs=require("fs");
const d=JSON.parse(fs.readFileSync(f));delete d.settings.adminPassword;
fs.writeFileSync(f,JSON.stringify(d,null,2))'
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart
```

### Pairing with GameNight

Optional. Paired, the lobby offers "Sign in with GameNight" next to the guest
name box, and a player who signs in there is seated here under their GameNight
username with no second account. Three steps, once per server, all from a
browser:

1. In GameNight, as a site admin, open Site Settings > Connected Apps and add
   this server: a slug (`finaltable`), a name, and the base URL players use to
   reach it. The URL must match exactly, scheme, host and port: it is the only
   place GameNight will ever send a token.
2. In this server's lobby, open the menu in the top corner and pick
   **admin** (it needs `ADMIN_PASSWORD` set), then enter the GameNight
   address and the slug.
   The signing key is fetched from GameNight, checked, and saved to
   `data/settings.json`; the button appears for everyone at once.
3. If GameNight ever regenerates its key, press **Refresh key** on the same
   page. **Unpair** takes the button away again.

Only the public key travels, and only this way round. GameNight signs each
sign-in with a private key it never shares, so this server can check a token
on its own and a leak here lets nobody forge one. The key id shown on the
Admin page matches the one on GameNight's Connected Apps page.

When both run on the same host, the address to enter can be the internal one -
`http://gamenight`, the container's name on the proxy network - rather than the
public URL. What is stored as the issuer is whatever GameNight calls itself in
its answer, not what was typed, so the tokens still verify against its public
name. That also sidesteps a host whose NAT will not let a container reach its
own public address.

The three environment variables (`GAMENIGHT_URL`, `GAMENIGHT_AUDIENCE`,
`GAMENIGHT_PUBLIC_KEY`, see `.env.example`) still work for a headless setup:
they seed the pairing the first time a server boots with nothing saved, and
after that the saved pairing wins, so a change made on the Admin page is
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
