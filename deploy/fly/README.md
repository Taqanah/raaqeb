# Raaqeb on Fly.io

One Fly machine runs Raaqeb, and Fly's proxy in front of it ends TLS, so no Caddy is needed. `fly.toml` beside this file is the sample; this guide says how to fill it in and why each line is there.

You need `flyctl` signed in, Docker, and a checkout of Raaqeb with Bun, on an amd64 host.

## 1. Build the image

The image is `ghcr.io/taqanah/raaqeb:<version>`. Until a release publishes it, you deploy the one you build:

```sh
bun install
bun run image          # loads ghcr.io/taqanah/raaqeb:<version> into the local Docker
```

`bun run image` loads the image of the host's platform, and Fly runs amd64 machines only, so build on an amd64 host. `[build]` in `fly.toml` names that image, so once a release publishes it Fly can pull it and the build step is not needed.

## 2. Create the app and its addresses

Copy `fly.toml` into an empty folder, replace `<app>` and `<region>`, and run there:

```sh
fly apps create <app>
fly ips allocate-v4 --shared
fly ips allocate-v6
fly ips list
```

The trusted proxies are `172.16.0.0/12` and the two addresses `fly ips list` shows. Raaqeb believes `X-Forwarded-For` and `X-Forwarded-Proto` only from these addresses. Set them in one of two places:

- in `RAAQEB_TRUSTED_PROXIES` in `fly.toml`, as the sample does; the variable wins, and the general settings page shows the field as managed by environment;
- or on the general settings page after onboarding, as `172.16.0.0/12, <the app's IPv4>, <the app's IPv6>`, with the `RAAQEB_TRUSTED_PROXIES` line deleted from `fly.toml`. Until it is saved, the sign-in log and the limits see Fly's proxy as every visitor.

Why each address:

- Fly's proxy connects to the machine from an address inside `172.16.0.0/12`. Fly documents that its proxy reaches the machine over a private IPv4 address but not the range; the range is what a test deploy saw (`172.16.74.106` and `172.16.11.186`).
- Fly appends the app's own address, the one the visitor reached, as the last entry of `X-Forwarded-For` ([Fly's request headers](https://docs.fly.io/networking/request-headers/)). Without them in the list, every visitor would take the app's address in the sign-in log and its rate limit, the subscription limits and a heartbeat's source.

A value left as `<...>` refuses the boot, naming the entry; on the settings page it refuses the save.

The setup check page, the last settings page, shows whether the page's own request came through a trusted proxy, and names the proxy's address when it did not.

## 3. Choose the database

**Postgres.** Set the database and the install key as Fly secrets, and delete the `[mounts]` section from `fly.toml`:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'    # the install key, 43 characters; keep a copy
fly secrets set --stage DATABASE_URL='postgres://...' RAAQEB_SECRET_KEY='<the key>'
```

With both set, Raaqeb writes nothing to the data directory, so it needs no volume, and onboarding skips the database screen. The install key encrypts every credential Raaqeb stores; without the same key, a restored database cannot open them. Better Auth's secret lives in the database, so `BETTER_AUTH_SECRETS` is optional.

**SQLite.** Keep `[mounts]` and create the volume in the app's region:

```sh
fly volumes create raaqeb_data --size 1 --region <region>
```

The volume is required: the SQLite file, its snapshots and `config.json` with the generated install key all live in `/data`. Fly mounts the volume owned by the image's user, uid 65532, so the non-root image writes to it unchanged. The mount's mode is 0755, which the image cannot change since it has no shell, so every boot logs this line, which is expected:

```
raaqeb: the data directory's mode is wider than 0700; config.json and raaqeb.sqlite hold secrets
```

Only the machine reaches the volume. With `RAAQEB_SECRET_KEY` set as a secret, `config.json` is not written and the line names `raaqeb.sqlite` alone. For the same 0755 mount, the setup check page under settings shows its data directory permissions check failing; that is expected on Fly too.

## 4. Deploy

```sh
fly deploy --local-only --ha=false
```

`--local-only` deploys the image from the local Docker. `--ha=false` keeps it to one machine: two machines would run two schedulers, each checking every monitor and sending every notification. Never scale the app above one machine.

`fly.toml` keeps that machine running: `auto_stop_machines = "off"` and `min_machines_running = 1`, since a stopped machine runs no checks. `h2_backend = true` has Fly's proxy speak HTTP/2 to the machine, which Raaqeb answers on the same port as HTTP/1.1. Fly ignores the image's Docker `HEALTHCHECK`, so `[[http_service.checks]]` asks `/health` instead, and `fly status` shows the machine failing while it answers 503. When the scheduler has not ticked for five minutes, Raaqeb exits and Fly's restart policy, `on-failure`, starts it again.

`fly logs` shows the log.

## 5. Domains and onboarding

Add a certificate for the address Raaqeb will be reached at, and one for each custom status page domain, then create the DNS records `fly certs setup` names and wait for `fly certs check` to report the certificate issued:

```sh
fly certs add raaqeb.example.com    # the public address
fly certs add status.example.com    # a custom status page domain
fly certs setup raaqeb.example.com
fly certs check raaqeb.example.com
```

Onboard at the address you mean to keep: the public address is pre-filled from the address the browser is at, and sign-in works only there. Onboarding at `https://<app>.fly.dev` and keeping the custom domain for later means changing the public address on the general settings page once the certificate is ready. A custom status page domain cannot be the public address's host.

## Commands

The image has no shell, but `fly ssh console -C` runs the binary directly:

```sh
fly ssh console -C "raaqeb set-address https://raaqeb.example.com"   # when the stored address refuses every sign-in
fly ssh console -C "raaqeb reset-password"                            # prints a reset link
```

## Upgrades

Build the new version with `bun run image`, change the tag in `[build]`, and run `fly deploy --local-only --ha=false` again. Migrations run on start, with a snapshot first on SQLite.
