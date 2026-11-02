# Deploying MoonRoom

One Docker Compose stack: Postgres, the API (migrations run on start), the web app in production
mode, Caddy (routing) and, optionally, a Cloudflare Tunnel. Only Caddy is reachable from outside;
the database and the API are never published.

```
friends -> Cloudflare -> cloudflared -> Caddy -> web (Next.js) -> api -> db
                                          \-> api (only /mal/callback)
```

## What needs you

1. A domain on Cloudflare (buy one, or move an existing one's DNS to Cloudflare).
2. A free Cloudflare Zero Trust account, then a tunnel: Zero Trust > Networks > Tunnels > Create a
   tunnel > Cloudflared. Copy its token into `TUNNEL_TOKEN`. In the tunnel's "Public hostnames"
   add your hostname (for example `moonroom.example.com`) with service `http://caddy:80`.
3. A MyAnimeList app (https://myanimelist.net/apiconfig) whose redirect URL is exactly
   `https://<your hostname>/mal/callback`. Keep `http://localhost:8000/mal/callback` too if you
   still run the dev setup, since MAL accepts several.
4. Docker with the Compose plugin on the machine that hosts the site (the PC today, the NAS
   later; see "Running on the NAS"), set to start on boot.

## First run

```bash
cd deploy
cp .env.example .env     # fill every empty value; the file explains how to generate each
docker compose up -d --build
docker compose exec api python -m app.cli invite    # invite code for the first account
docker compose exec api python -m app.cli promote <username>   # after registering, to become admin
docker compose exec api python -m app.cli reset-2fa <username>   # turn off two-factor login for someone locked out
```

Open `PUBLIC_URL`. Check the stack with `docker compose ps` (all `healthy`) and
`docker compose logs -f api`.

## Updating

```bash
git pull
cd deploy && docker compose up -d --build
```

The API applies pending migrations when it starts. Roll back by checking out the previous commit and
running the same command (migrations are not undone automatically).

## Automatic deploys

A systemd timer checks `origin/main` every minute and rebuilds production when it changes. It works
in its own clone, `~/moonroom-prod`, so it never touches your dev checkout or uncommitted work. Run
once in WSL (systemd must be on: `/etc/wsl.conf` with `[boot]` / `systemd=true`, then `wsl --shutdown`
from Windows):

```bash
git clone https://github.com/GothHeit/MoonRoom ~/moonroom-prod
cp ~/projetos/MoonRoom/deploy/.env ~/moonroom-prod/deploy/.env
mkdir -p ~/.config/systemd/user
cp ~/moonroom-prod/deploy/systemd/moonroom-deploy.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now moonroom-deploy.timer
loginctl enable-linger "$USER"    # keep it running when no terminal is open
```

The compose project is named `moonroom`, so the new clone takes over the existing containers and
volumes (database included). Watch it with `journalctl --user -u moonroom-deploy -f`, run it now
with `systemctl --user start moonroom-deploy`. A failed build is retried every minute and the old
version keeps running. Stop it with `systemctl --user disable --now moonroom-deploy.timer`. The
script lives in the clone, so it updates itself with each deploy.

## Backups

`deploy/backup.sh` writes a compressed dump to `deploy/backups/` and keeps the last 14. Schedule it
with cron. Restore into a running stack:

```bash
gunzip -c backups/moonroom-<stamp>.sql.gz | docker compose exec -T db psql -U app app
```

Keep a copy off the PC too (cloud drive, another disk). Also back up `deploy/.env`: losing
`TOKEN_ENCRYPTION_KEY` makes linked MAL accounts unreadable.

### Rotating JWT_SECRET

Rotate it if it may have leaked, or once a year. Nobody is signed out:

1. Move the current value to `JWT_PREVIOUS_SECRETS` and put a new one in `JWT_SECRET`.
2. Restart the stack. Tokens signed with the old secret keep working until they expire; a video
   already playing may need a reload.
3. A day later, empty `JWT_PREVIOUS_SECRETS` and restart again.

## Shared cache

A `redis` container keeps MAL and ani.zip answers across API restarts and workers (128 MB, no
persistence, no published port, no .env keys). It is optional at runtime: if it is down the API
logs one warning and uses its in-process cache. Flush it with `docker compose exec redis redis-cli flushall`.

## Proxy and cookie settings

- `TRUST_PROXY_HEADERS=true` on the API is safe here because only Caddy can reach it, and Caddy
  replaces `X-Forwarded-For` with the visitor address Cloudflare reports. Never expose the API port
  directly while this is on, or anyone could fake their IP and dodge the login rate limits.
- `COOKIE_SECURE=true` (default) keeps the login cookies HTTPS-only. Browsers see https at
  Cloudflare, so this works behind the tunnel. Set it to `false` only to try the stack over plain
  http on your own network.

## Video sources

`VIDEO_SOURCES` lists unlicensed sources and is meant for this private deployment only. Leave it
empty for anything public or any store build. `PT_SYNOPSIS_SCRAPE` is the same kind of switch: it
fetches Portuguese synopses from an unlicensed site, so keep it `false` outside this deployment.

Unless a viewer picks a source by hand in the player, each episode plays from the best version
for them across every enabled source, in this order: playable, their audio (a dub in the language
they chose in Settings, else the original), their subtitles (soft over burned-in), then quality
(the best, or the best under the limit they set). The order of `VIDEO_SOURCES` only breaks ties,
so more sources never make the pick worse. `kaa` and `anizone` carry every dub as an audio track
of the same stream; the player's Audio menu switches between them. `uniquestream` (AnimeStream)
offers the original audio and a Portuguese dub as separate copies at up to 1080p, but only answers
connections from a home address, not from a datacenter.

## Local library

The `local` video source plays your own episode files, converted ahead of time so watching
costs the server almost nothing (no transcoding while someone watches). Each episode keeps its
original video (repackaged, not re-encoded) for devices that can play it, plus an H.264 copy for
the rest. Subtitles stay styled, with the fonts from the files, and a plain copy for iPhone full
screen. It is private like the other sources: never enable it on anything public.

The originals are only read and stay where they are; keep them, they are the master copy. The
converted copies go in `D:\moonroom-library` (`/mnt/d/moonroom-library` in WSL) on the PC, or the
NAS share once it hosts the site: the original video again plus the H.264 copy, so expect a few
times the size of the originals. Nothing is written to C:. Conversion runs on the PC itself with
the ffmpeg already installed in WSL, so the Docker images don't grow.

The H.264 copy uses x264's `slow` preset at CRF 19 with the animation tuning: the same picture
as a faster preset in a smaller file. It takes longer to convert, once, which is the right trade
for a library that is converted once and watched many times. `--preset` and `--crf` change it
(`veryslow` is a little smaller again and much slower; a lower CRF is better and bigger).

1. Give each show folder a `moonroom.toml` next to its episodes:

   ```toml
   mal_id = 2167
   title = "Clannad"
   default_subtitle = "Emmid"        # subtitle track shown first, by part of its title
   # episode_pattern = '- (\d+)'     # regex whose first group is the episode number
   # episode_offset = 0
   # audio_language = "jpn"          # audio track to keep (default jpn, por for a dub)
   # lang = "dub"                    # for a dubbed release (default "sub")
   # [episodes]                      # explicit names win over the pattern
   # "Clannad - Another World.mkv" = 25
   ```

   The episode number is taken from the last number in each file name outside brackets. Check
   the mapping of everything at once; this converts nothing and also lists the folders that
   have videos but no `moonroom.toml` yet:

   ```sh
   cd ~/projetos/MoonRoom/apps/api
   uv run python -m app.library scan /mnt/d/hate/art/anime --dry-run
   ```

2. Convert the whole tree. Episodes already converted are skipped, so it can be stopped and run
   again whenever you add a show; an episode that fails is reported and the rest carry on:

   ```sh
   uv run python -m app.library scan /mnt/d/hate/art/anime --out /mnt/d/moonroom-library
   ```

   Each run appends a summary (converted, skipped, failed, folders without a manifest) to
   `ingest.log` in the library folder. `--force` converts again.

   One folder at a time, with flags instead of a manifest, works too:

   ```sh
   uv run python -m app.library ingest /mnt/d/hate/art/anime/Clannad --mal-id 2167 \
     --default-subtitle Emmid --out /mnt/d/moonroom-library
   ```

   `--episodes 1,2` converts only some. A title keeps the name it was first given unless a
   later run names it again.

3. Serve it: in `deploy/.env` set `COMPOSE_FILE=compose.yaml:compose.library.yaml` and
   `LIBRARY_DIR` to the library folder, add `local` to `VIDEO_SOURCES` (e.g.
   `zoko,animesdigital,local`), then `docker compose up -d`. The title then lists "Local
   library" in the player's source menu. New conversions show up within a minute, without a
   restart.

**Two library folders.** When one disk fills up, start a second folder and add
`compose.library-more.yaml` to `COMPOSE_FILE` with `LIBRARY_DIR_2` pointing at it. A title is
served from whichever folder holds it, so you can simply move a title's folder (`<mal id>/`)
from one to the other, or leave a symlink behind. Outside Docker, list both in
`LOCAL_LIBRARY_DIRS`, comma-separated.

For development, set `LOCAL_LIBRARY_DIRS=/mnt/d/moonroom-library` and add `local` to
`VIDEO_SOURCES` in `apps/api/.env`.

## Running on the NAS

Once the NAS is set up it runs the whole stack on its own: database, API, web, Caddy, the tunnel
and the automatic deploys. The PC is then only needed to convert new episodes, if you want its
faster CPU for that; nothing on the site depends on it. Nothing in the stack is PC-specific, so
this is a move, not a rewrite.

What the NAS needs: Docker with the Compose plugin set to start on boot, git, SSH access, and a shared folder for the library (say
`/volume1/moonroom-library`; the path depends on the NAS's system). The library is plain files
read over the local disk, so the NAS's CPU barely matters for watching.

**Prepare (the site stays up on the PC):**

1. On the NAS, clone the repo into a folder on its data disks, e.g.
   `git clone https://github.com/GothHeit/MoonRoom ~/moonroom-prod`.
2. Copy `~/moonroom-prod/deploy/.env` from the PC into the same place on the NAS. Keep every
   secret exactly as it is: a new `JWT_SECRET` logs everyone out and a new
   `TOKEN_ENCRYPTION_KEY` makes linked MAL accounts unreadable. Change only `LIBRARY_DIR` to the
   NAS folder, and drop `LIBRARY_DIR_2` and `compose.library-more.yaml` unless the NAS has two.
   `PUBLIC_URL`, `TUNNEL_TOKEN` and the MAL app stay the same, since the hostname doesn't
   change.
3. Copy the library to the NAS share: it is self-contained, so copy `D:\moonroom-library` as
   is (Windows: `robocopy D:\moonroom-library \\<nas>\moonroom-library /E /MT:8`, or rsync from
   WSL). Run it again just before switching to pick up anything new.
4. Build the images on the NAS without starting the site: `cd ~/moonroom-prod/deploy &&
   docker compose build`.

**Switch (a few minutes of downtime):**

5. On the PC, stop the automatic deploys and the site, keeping its data:
   `systemctl --user disable --now moonroom-deploy.timer`, then
   `cd ~/moonroom-prod/deploy && ./backup.sh && docker compose stop`. Stop it before the NAS
   starts: two machines on the same tunnel would split visitors between two databases.
6. Copy the new dump (`deploy/backups/moonroom-<stamp>.sql.gz`) and, to keep uploaded profile
   pictures, the avatars volume (`docker run --rm -v moonroom_avatars:/a -v "$PWD/backups":/b
   alpine tar czf /b/avatars.tgz -C /a .`) to the NAS's `deploy/backups/`.
7. On the NAS, start the database alone, restore, then everything:

   ```bash
   cd ~/moonroom-prod/deploy
   docker compose up -d db
   gunzip -c backups/moonroom-<stamp>.sql.gz | docker compose exec -T db psql -U app app
   docker run --rm -v moonroom_avatars:/a -v "$PWD/backups":/b alpine tar xzf /b/avatars.tgz -C /a
   docker compose up -d
   ```

8. Check: `docker compose ps` shows everything `healthy`, the site opens on its usual address,
   you are still signed in, and a local library episode plays.
9. Automatic deploys and backups on the NAS: if its system has systemd user services
   (`systemctl --user status` answers), set up the timer as in "Automatic deploys" above.
   Otherwise schedule `deploy/auto-deploy.sh` every minute with the NAS's task scheduler or
   cron, and `deploy/backup.sh` daily; the script needs bash, git and `flock`. Keep a copy of the backups and of `deploy/.env` off the NAS.

**Afterwards:** leave the PC's stopped containers and volumes alone for a week or two as the way
back (start them with `docker compose start` and re-enable the timer, after stopping the NAS;
anything changed on the NAS in between is lost). Then remove them with `docker compose down -v`
in the PC's `~/moonroom-prod/deploy`.

**Converting new episodes** still works from the PC, writing straight to the NAS share: mount it
in WSL (e.g. map it as Z: in Windows, then `sudo mkdir -p /mnt/z && sudo mount -t drvfs Z: /mnt/z`)
and run `scan` with `--out /mnt/z/moonroom-library`. Episodes are assembled in a hidden folder
and only appear once finished, so converting while the site serves the library is safe. The NAS
can also run `scan` itself if it has Python and ffmpeg; it is just slower.

## Moving to a VPS later

Copy the repo and `.env`, restore a backup, then:

1. In `.env`: remove `COMPOSE_PROFILES`, set `SITE_ADDRESS` to your domain.
2. Point the domain's DNS at the VPS.
3. `docker compose -f compose.yaml -f compose.vps.yaml up -d --build` (publishes 80 and 443;
   Caddy gets the certificate by itself).

Uploaded profile pictures live in the `avatars` Docker volume, not in the database, so the dump does
not include them. Losing them is harmless (people fall back to their MAL picture or initial and can
upload again), but to keep them copy the volume, e.g.
`docker run --rm -v <project>_avatars:/a -v "$PWD/backups":/b alpine tar czf /b/avatars.tgz -C /a .`.
