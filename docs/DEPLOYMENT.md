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
- Its own `.env` beside the compose files, holding the two database
  passwords, the `CLAIM_TOKEN` that opens it the first time, and any sizing.
  It is gitignored, so a pull never touches it. Compose reads it on the host
  and passes every value the container needs in, so the container never has
  to read the file; it sees it through the bind mount all the same, and skips
  it when the permissions say it is none of its business, so mode 600 is
  right and the `env_file_skipped` line at boot is the expected shape of
  things.

The clone is the deployment. `docker-compose.prod.yml` is committed and carries
this host's specifics: the bind mount, the proxy network, `TRUST_PROXY`, and
memory sized for a box that has other tenants.

### The first ten minutes of a new server

Two things need each other here. Mail is what makes an account, and the Admin
page — where mail is set — needs an account to open it. The claim token is
the way through: it makes the first account with no mail at all, and nothing
after it needs a shell.

1. Write `.env`: `DB_PASSWORD`, `DB_ROOT_PASSWORD`, and a `CLAIM_TOKEN` of
   sixteen characters or more (`openssl rand -hex 16` makes one).
2. Bring the stack up. The boot log says `claim_open`.
3. Open the lobby. The sign-in card says the server has no administrator yet
   and offers **Claim this server**: a name, a password, an address, and the
   token. You are signed in as the administrator, and the Admin page opens
   on **Mail**.
4. Set the public address and the mail server there. Press **Test and send
   me one**; when it arrives, press **Save**. Players can sign up from that
   moment; nobody restarts anything.
5. `CLAIM_TOKEN` does nothing now. Take it out of `.env` whenever convenient;
   the boot log says `claim_token_stale` until you do, and that is all it
   says.

A server paired with a GameNight can skip the token: sign in there, and the
first account through the door administers this one.

**When the mail does not arrive.** New hosts have unreliable mail for a
while — a relay that is not quite right, a domain still warming up. A player
whose link never came is not stuck: their sign-up is held for a day, and the
Users page lists it under **Waiting on email** with a **Let them in** button.
They sign in with the name and password they chose.

### Who administers the server

Nobody, at first - and then whoever makes the first account on it. There is no
admin password: the Admin page and ending a running tournament from the table
menu belong to an account carrying the administrator role, and on a fresh
server the first account through the door gets it, whichever door - the
claim above, a GameNight sign-in, or a link in the mail. The boot log says
`admin_claimed` when that happens. A server left reachable before its owner
got to it has handed the keys to whoever got there first, which is what the
claim token is for: while it is set, the ordinary doors still work, but the
claim is the one that needs nothing else in place.

Two cases where that is not the answer, and one variable for both. A server
left reachable before its owner got to it has handed the keys to a stranger;
and an administrator can lose their password and the address it would be reset
to. Either way, put the account's name in `ADMIN_PROMOTE` and restart:

```bash
echo 'ADMIN_PROMOTE=Bryce' >> /opt/finaltable/.env
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

It is applied on every boot and never takes the role away, so it can be left
where it is. A name no account here has logs an error and changes nothing.
Taking the role off the stranger is then done from the Users page.

A server upgrading from a version that had `ADMIN_PASSWORD` promotes nobody -
it has accounts already, and handing it to whoever signs in next would be
arbitrary. It says `admin_unclaimed` at boot until `ADMIN_PROMOTE` names one,
or `CLAIM_TOKEN` lets somebody claim it from the lobby. The old variable is
ignored, and says so.

### Pairing with GameNight

Optional. Paired, the lobby offers "Sign in with GameNight" beside the
sign-in form, and a player who signs in there is seated here under their GameNight
username with no second account. Three steps, once per server, all from a
browser:

1. In GameNight, as a site admin, open Site Settings > Connected Apps and add
   this server: a slug (`finaltable`), a name, and the base URL players use to
   reach it. The URL must match exactly, scheme, host and port: it is the only
   place GameNight will ever send a token.
2. In this server's lobby, open the menu in the top corner and pick
   **admin** (it is only there for an administrator), then enter the GameNight
   address and the slug.
   The signing key is fetched from GameNight, checked, and saved in the
   database; the button appears for everyone at once.
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
they seed the pairing on a boot that finds nothing saved, and after that the
saved pairing wins, so a change made on the Admin page is not undone by a
restart. Two things differ from the page. The seed fetches nothing, so
`GAMENIGHT_URL` is stored as the issuer exactly as written and must be
GameNight's public name (`https://gamenight.poker`), not the internal address
above. And the key has to be pasted: it is the `pem` in GameNight's answer at
`/api/v1/sso`, on one line with `\n` for each line break. Once the boot has
persisted the pairing the three lines can come out of `.env`.

### Seeding a saved setting from the environment

Mail, the GameNight pairing and the Server knobs are settings the Admin page
keeps in the database, and the environment only seeds a boot that finds
nothing saved. So to change one from the shell - re-pairing after a wipe,
pointing a server at a relay without an administrator to hand - the saved row
has to go first, or the seed is ignored:

```bash
cd /opt/finaltable
docker exec finaltable-db mariadb -ufinaltable -p"$DB_PASSWORD" finaltable \
  -e "delete from settings where k='mail'"     # or 'gamenight', or 'server'
# put the seed in .env: SMTP_URL and MAIL_FROM, or the three GAMENIGHT_ lines
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker logs --since 1m finaltable | grep -E 'mail_configured|gamenight_paired'
```

`up -d` rather than `restart`: the environment changed, and only a recreate
carries that in. The boot applies the seed and writes it down, and from then
on the page wins again - so take the seed back out of `.env` and `up -d` once
more, and the secret lives in one place. A mail seed can be tried before an
administrator presses **Test and send me one**:

```bash
docker exec finaltable node -e 'require("nodemailer").createTransport(process.env.SMTP_URL).verify().then(() => console.log("ok"), (e) => console.log(e.message))'
```

Note that a bootstrap row counts as saved: a server brought up on
`MAIL_TRANSPORT=log` has a `mail` row in `log` mode, and an `SMTP_URL` added
later does nothing until that row is deleted or the page is used.

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

Tournaments, accounts, identities, chat, the hand histories, the settings and
the admin log live in the database, whose volume (`finaltable-db`) is not the
image and not the clone, so neither a pull nor a rebuild touches the field
that was playing. A running tournament is recorded between hands and seated
again on the way back up. The `finaltable-data` volume at `/app/data` holds
only what the file-to-database import left behind.

## Starting over

A server that should forget everything - a test box being reset, a database
that was never worth keeping - is taken down and brought back in a few
minutes. What survives is nothing on this host: GameNight's side of the
pairing (its Connected Apps entry) stays, so re-pairing is only this side.

```bash
cd /opt/finaltable
docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v --remove-orphans
docker rmi finaltable:latest finaltable:previous
cd / && rm -rf /opt/finaltable
git clone github-finaltable:OWNER/FinalTable.git /opt/finaltable
cd /opt/finaltable
cp .env.example .env    # DB_PASSWORD, DB_ROOT_PASSWORD, CLAIM_TOKEN
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`down -v` takes the named volumes and the anonymous `node_modules` one with
the containers; the deploy key and its ssh alias live in `~/.ssh`, outside the
clone, and are reused. On a box too small to build, ship the image from
elsewhere before `up -d`, as above. Then the first ten minutes, from the top:
claim it, set mail, re-pair GameNight from the Admin page or seed it as
described under Pairing.

## Running it somewhere else

Anyone self-hosting on a machine with room to build needs none of the above -
clone the repository and use the compose file on its own, as the
[README](../README.md) describes:

```bash
docker compose up -d --build
```
