#!/bin/sh
# Raaqeb's installer for Linux and macOS. Run as root:
#
#   curl -fsSL https://raaqeb.dev/install.sh | sudo sh
#
# It downloads the latest stable release's binary and SHA256SUMS from
# https://github.com/Taqanah/raaqeb/releases, both from one release. Two
# variables change that: RAAQEB_VERSION, such as 0.2.0-beta.1, names the
# release to install (a pre-release is never the latest), and
# RAAQEB_DOWNLOAD_URL, which wins over it, is the folder or mirror holding
# the binaries and SHA256SUMS. It picks the binary for this machine, checks
# it against SHA256SUMS, installs it as /usr/local/bin/raaqeb, creates the
# service's user and data directory, writes the service, starts it on
# 127.0.0.1:3000 and prints the next step.
# On Linux: the raaqeb user, /var/lib/raaqeb, /etc/raaqeb/raaqeb.env, and a
# systemd or OpenRC service. On a Mac with Apple Silicon: the _raaqeb user,
# /usr/local/var/raaqeb, /usr/local/etc/raaqeb/raaqeb.env, and a launchd
# daemon. Running it again upgrades the binary in place and keeps the data
# and the env file.
set -eu

bin=/usr/local/bin/raaqeb
data_dir=/var/lib/raaqeb
env_dir=/etc/raaqeb
env_file=$env_dir/raaqeb.env

say() {
	printf 'raaqeb install: %s\n' "$*"
}

fail() {
	printf 'raaqeb install: %s\n' "$*" >&2
	exit 1
}

# The binary's target for a machine (uname -m) and a C library (glibc or musl).
target_of() {
	case $1 in
	x86_64) arch=x64 ;;
	aarch64) arch=arm64 ;;
	*) fail "Raaqeb has no binary for this machine ($1); it runs on x86_64 and aarch64" ;;
	esac
	if [ "$2" = musl ]; then
		printf '%s-musl\n' "$arch"
	else
		printf '%s\n' "$arch"
	fi
}

# musl when the system's own ldd under the root given says so, glibc
# otherwise: a glibc system may carry the musl package, and an Alpine one
# gcompat's glibc loader, so the loaders on disk do not tell.
libc_of() {
	if "$1/usr/bin/ldd" --version 2>&1 | grep -qi musl; then
		echo musl
	else
		echo glibc
	fi
}

# systemd, openrc or none: the init system running under the root given.
init_of() {
	if [ -d "$1/run/systemd/system" ]; then
		echo systemd
	elif [ -e "$1/run/openrc/softlevel" ]; then
		echo openrc
	else
		echo none
	fi
}

# The macOS binary for a machine (uname -m) and whether the shell runs under
# Rosetta (sysctl.proc_translated), where an Apple Silicon Mac reads as
# x86_64: Apple Silicon only, because Intel Macs are no longer sold and no
# hardware tests them.
darwin_file() {
	if [ "$1" = arm64 ] || [ "$2" = 1 ]; then
		echo raaqeb-darwin-arm64
	else
		fail "Raaqeb's macOS binary is for Apple Silicon (arm64); this Mac is $1"
	fi
}

# The tag of the latest stable release of the releases address given, read
# from the redirect of its /latest, which is not followed: GitHub's API
# would count against a rate limit, a redirect does not. A repository with
# no release sends /latest to its releases list, or answers 404.
latest_tag() {
	command -v curl >/dev/null 2>&1 ||
		fail "finding the latest release needs curl; install it, or set RAAQEB_VERSION or RAAQEB_DOWNLOAD_URL"
	status=0
	location=$(curl -fs -m 30 -o /dev/null -w '%{redirect_url}' "$1/latest") || status=$?
	case $status in
	0) ;;
	22) fail "$1 has no release yet; set RAAQEB_VERSION to a version, or RAAQEB_DOWNLOAD_URL to a folder holding the binaries and SHA256SUMS" ;;
	*) fail "could not reach $1/latest; check the network, or set RAAQEB_DOWNLOAD_URL to a folder holding the binaries and SHA256SUMS" ;;
	esac
	tag=${location##*/releases/tag/}
	if [ "$tag" = "$location" ] || [ -z "$tag" ]; then
		fail "$1 has no release yet; set RAAQEB_VERSION to a version, or RAAQEB_DOWNLOAD_URL to a folder holding the binaries and SHA256SUMS"
	fi
	printf '%s\n' "$tag"
}

# The folder the binaries and SHA256SUMS are downloaded from, for the
# releases address given: RAAQEB_DOWNLOAD_URL, else the release RAAQEB_VERSION
# names, else the latest, so a release's files all come from one folder.
download_url() {
	if [ -n "${RAAQEB_DOWNLOAD_URL:-}" ]; then
		printf '%s\n' "${RAAQEB_DOWNLOAD_URL%/}"
		return
	fi
	if [ -n "${RAAQEB_VERSION:-}" ]; then
		version=${RAAQEB_VERSION#v}
		case $version in
		"" | *[!0-9A-Za-z.+-]* | [!0-9A-Za-z]*) fail "RAAQEB_VERSION must be a version such as 0.2.0 or 0.2.0-beta.1" ;;
		esac
		tag=v$version
	else
		tag=$(latest_tag "$1")
	fi
	printf '%s/download/%s\n' "$1" "$tag"
}

# The first id from 300 below 500 that no line of `dscl . -list` on standard
# input holds: macOS keeps ids under 500 for the system's own accounts.
free_id() {
	awk '{ held[$2] = 1 } END { for (id = 300; id < 500; id++) if (!(id in held)) { print id; exit 0 } exit 1 }'
}

# Checks the file named in the folder against that folder's SHA256SUMS, with
# sha256sum, or shasum on macOS, which has no sha256sum.
verify() {
	line=$(grep " $2\$" "$1/SHA256SUMS") || fail "SHA256SUMS lists no $2"
	if command -v sha256sum >/dev/null 2>&1; then
		check="sha256sum -c -"
	else
		check="shasum -a 256 -c -"
	fi
	(cd "$1" && printf '%s\n' "$line" | $check >/dev/null 2>&1) ||
		fail "$2 does not match its checksum in SHA256SUMS"
}

# The systemd unit, hardened.
unit_text() {
	cat <<'UNIT'
[Unit]
Description=Raaqeb monitoring and status pages
After=network-online.target
Wants=network-online.target

[Service]
User=raaqeb
Group=raaqeb
Environment=RAAQEB_DATA_DIR=/var/lib/raaqeb RAAQEB_HOST=127.0.0.1 RAAQEB_PORT=3000
EnvironmentFile=-/etc/raaqeb/raaqeb.env
WorkingDirectory=/var/lib/raaqeb
ExecStart=/usr/local/bin/raaqeb serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/raaqeb
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
}

# The OpenRC service script. The env file is read at its top level, after
# the script's own values, so a line set there wins.
openrc_text() {
	cat <<'OPENRC'
#!/sbin/openrc-run
description="Raaqeb monitoring and status pages"
supervisor=supervise-daemon
command=/usr/local/bin/raaqeb
command_args=serve
command_user=raaqeb:raaqeb
directory=/var/lib/raaqeb
umask=0077
respawn_delay=5
respawn_max=0
# supervise-daemon opens the log as the raaqeb user, so its folder is that user's.
output_log=/var/log/raaqeb/raaqeb.log
error_log=/var/log/raaqeb/raaqeb.log

export RAAQEB_DATA_DIR=/var/lib/raaqeb RAAQEB_HOST=127.0.0.1 RAAQEB_PORT=3000
if [ -f /etc/raaqeb/raaqeb.env ]; then
	set -a
	. /etc/raaqeb/raaqeb.env
	set +a
fi

depend() {
	need net
}

start_pre() {
	checkpath --directory --owner raaqeb:raaqeb --mode 0750 /var/log/raaqeb
}
OPENRC
}

# The launchd daemon. launchd reads no env file, so a shell exports the
# daemon's own values, then reads the env file, so a line set there wins.
# KeepAlive on an unsuccessful exit is systemd's Restart=on-failure.
plist_text() {
	cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>raaqeb</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>export RAAQEB_DATA_DIR=/usr/local/var/raaqeb RAAQEB_HOST=127.0.0.1 RAAQEB_PORT=3000; set -a; if [ -f /usr/local/etc/raaqeb/raaqeb.env ]; then . /usr/local/etc/raaqeb/raaqeb.env; fi; set +a; exec /usr/local/bin/raaqeb serve</string>
	</array>
	<key>UserName</key>
	<string>_raaqeb</string>
	<key>GroupName</key>
	<string>_raaqeb</string>
	<key>WorkingDirectory</key>
	<string>/usr/local/var/raaqeb</string>
	<key>Umask</key>
	<integer>63</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>StandardOutPath</key>
	<string>/usr/local/var/log/raaqeb/raaqeb.log</string>
	<key>StandardErrorPath</key>
	<string>/usr/local/var/log/raaqeb/raaqeb.log</string>
</dict>
</plist>
PLIST
}

# The env file written on the first install, every line a comment.
env_text() {
	cat <<'ENV'
# Raaqeb's boot settings on this server, each explained at
# https://raaqeb.dev/en/docs/operate/boot-settings. The service
# reads this file after its own values, so a line set here wins. Remove the
# # before a line to set it, then restart the service. systemd reads this
# file and OpenRC and launchd run it as sh, so put a value in single quotes
# unless it holds only letters, digits and . , : / - _
#
# The bind address; 0.0.0.0 listens on every interface.
# RAAQEB_HOST=127.0.0.1
#
# The port.
# RAAQEB_PORT=3000
#
# The proxies whose forwarded headers are believed; a proxy on this server
# connects from 127.0.0.1 or ::1. Set here, it locks the field on the
# general settings page.
# RAAQEB_TRUSTED_PROXIES=127.0.0.1,::1
#
# A Postgres database, in place of the onboarding page's choice.
# DATABASE_URL='postgres://user:password@host:5432/raaqeb'
#
# The install key; when unset it is generated into config.json in the data
# directory. Keep a copy: without it, stored credentials cannot be opened.
# RAAQEB_SECRET_KEY=
#
# Better Auth's secret in its versioned form; stored in the database when unset.
# BETTER_AUTH_SECRETS=
ENV
}

# Downloads a URL to a file with curl or wget, whichever is here; a failure
# says what the optional third argument adds.
fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$2" "$1" || fail "could not download $1${3:+ ($3)}"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1" || fail "could not download $1${3:+ ($3)}"
	else
		fail "neither curl nor wget is installed"
	fi
}

# The raaqeb system user and group, made once.
create_user() {
	if id raaqeb >/dev/null 2>&1; then
		return
	fi
	nologin=$(command -v nologin || echo /bin/false)
	if command -v useradd >/dev/null 2>&1; then
		useradd --system --user-group --no-create-home \
			--home-dir "$data_dir" --shell "$nologin" raaqeb
	elif command -v adduser >/dev/null 2>&1; then
		addgroup -S raaqeb
		adduser -S -D -H -h "$data_dir" -s "$nologin" -G raaqeb raaqeb
	else
		fail "neither useradd nor adduser is installed"
	fi
}

# The address the service listens on, as the env file leaves it.
listen_address() {
	(
		RAAQEB_HOST=127.0.0.1
		RAAQEB_PORT=3000
		set -a
		. "$env_file"
		printf '%s:%s\n' "$RAAQEB_HOST" "$RAAQEB_PORT"
	)
}

# The _raaqeb user and group on a Mac, made once, hidden, with no shell and
# no home, as macOS names its own daemons' accounts.
create_mac_user() {
	if ! dscl . -read /Groups/_raaqeb >/dev/null 2>&1; then
		gid=$({
			dscl . -list /Users UniqueID
			dscl . -list /Groups PrimaryGroupID
		} | free_id) || fail "no id under 500 is free for the _raaqeb group"
		dscl . -create /Groups/_raaqeb PrimaryGroupID "$gid"
		dscl . -create /Groups/_raaqeb Password '*'
	fi
	if dscl . -read /Users/_raaqeb >/dev/null 2>&1; then
		return
	fi
	uid=$({
		dscl . -list /Users UniqueID
		dscl . -list /Groups PrimaryGroupID
	} | free_id) || fail "no id under 500 is free for the _raaqeb user"
	gid=$(dscl . -read /Groups/_raaqeb PrimaryGroupID | awk '{ print $2 }')
	dscl . -create /Users/_raaqeb UniqueID "$uid"
	dscl . -create /Users/_raaqeb PrimaryGroupID "$gid"
	dscl . -create /Users/_raaqeb UserShell /usr/bin/false
	dscl . -create /Users/_raaqeb NFSHomeDirectory /var/empty
	dscl . -create /Users/_raaqeb RealName Raaqeb
	dscl . -create /Users/_raaqeb Password '*'
	dscl . -create /Users/_raaqeb IsHidden 1
	dscl . -append /Groups/_raaqeb GroupMembership _raaqeb
}

# Installs the checked binary on a Mac and starts its launchd daemon.
install_macos() {
	create_mac_user
	mkdir -p /usr/local/bin "$data_dir" "$env_dir" /usr/local/var/log/raaqeb
	chown _raaqeb:_raaqeb "$data_dir" /usr/local/var/log/raaqeb
	chmod 0700 "$data_dir"
	chmod 0750 /usr/local/var/log/raaqeb
	chown root:_raaqeb "$env_dir"
	chmod 0750 "$env_dir"
	if [ ! -e "$env_file" ]; then
		env_text >"$env_file"
		chown root:_raaqeb "$env_file"
		chmod 0640 "$env_file"
	fi

	cp "$1" "$bin.new"
	chmod 0755 "$bin.new"
	# A binary carried in by a browser keeps the quarantine flag, under which launchd cannot run it.
	xattr -d com.apple.quarantine "$bin.new" 2>/dev/null || true
	mv -f "$bin.new" "$bin"
	say "installed $bin"

	plist=/Library/LaunchDaemons/raaqeb.plist
	plist_text >"$plist"
	chown root:wheel "$plist"
	chmod 0644 "$plist"
	# A daemon booted out is gone only once launchd says so; bootstrap before that fails.
	if launchctl print system/raaqeb >/dev/null 2>&1; then
		launchctl bootout system/raaqeb 2>/dev/null || true
		tries=0
		while launchctl print system/raaqeb >/dev/null 2>&1 && [ "$tries" -lt 30 ]; do
			tries=$((tries + 1))
			sleep 1
		done
	fi
	launchctl bootstrap system "$plist"
	wait_healthy /usr/local/var/log/raaqeb/raaqeb.log

	listen=$(listen_address)
	say "Raaqeb is running and answers at http://$listen."
	say "Next: put a reverse proxy in front of it (Caddy, Nginx or Traefik; https://raaqeb.dev/en/docs/operate/reverse-proxy),"
	say "or set RAAQEB_HOST=0.0.0.0 in $env_file and run: sudo launchctl kickstart -k system/raaqeb"
	say "Then open its address in a browser to finish setup."
}

# Waits up to five minutes for the service's /health to answer 200: an
# upgrade snapshots and migrates the database before it listens.
wait_healthy() {
	tries=0
	until (
		set -a
		. "$env_file"
		"$bin" health
	) >/dev/null 2>&1; do
		tries=$((tries + 1))
		if [ "$tries" -ge 300 ]; then
			fail "Raaqeb did not answer /health within five minutes; its log: $1"
		fi
		sleep 1
	done
}

main() {
	[ "$(id -u)" = 0 ] || fail "run this as root, for example through sudo"

	url=$(download_url https://github.com/Taqanah/raaqeb/releases)
	os=$(uname -s)
	if [ "$os" = Darwin ]; then
		file=$(darwin_file "$(uname -m)" "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)")
		data_dir=/usr/local/var/raaqeb
		env_dir=/usr/local/etc/raaqeb
		env_file=$env_dir/raaqeb.env
	else
		libc=$(libc_of "")
		file=raaqeb-linux-$(target_of "$(uname -m)" "$libc")
		init=$(init_of "")
	fi

	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	say "downloading $file from $url"
	hint=
	if [ -z "${RAAQEB_DOWNLOAD_URL:-}" ] && [ -n "${RAAQEB_VERSION:-}" ]; then
		hint="is $RAAQEB_VERSION a release of Raaqeb?"
	fi
	fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS" "$hint"
	fetch "$url/$file" "$tmp/$file" "$hint"
	verify "$tmp" "$file"

	if [ "$os" = Darwin ]; then
		install_macos "$tmp/$file"
		return
	fi

	if [ "$libc" = musl ] && command -v apk >/dev/null 2>&1; then
		say "adding libstdc++ and libgcc, which the musl binary needs"
		apk add --no-cache --quiet libstdc++ libgcc
	fi

	create_user
	mkdir -p "$data_dir" "$env_dir"
	chown raaqeb:raaqeb "$data_dir"
	chmod 0700 "$data_dir"
	chown root:raaqeb "$env_dir"
	chmod 0750 "$env_dir"
	if [ ! -e "$env_file" ]; then
		env_text >"$env_file"
		chown root:raaqeb "$env_file"
		chmod 0640 "$env_file"
	fi

	# A new file moved over the old one, so a running binary is replaced whole.
	cp "$tmp/$file" "$bin.new"
	chmod 0755 "$bin.new"
	mv -f "$bin.new" "$bin"
	say "installed $bin"

	case $init in
	systemd)
		unit_text >/etc/systemd/system/raaqeb.service
		systemctl daemon-reload
		systemctl enable --quiet raaqeb
		systemctl restart raaqeb
		wait_healthy "journalctl -u raaqeb"
		;;
	openrc)
		openrc_text >/etc/init.d/raaqeb
		chmod 0755 /etc/init.d/raaqeb
		rc-update add raaqeb default >/dev/null
		rc-service raaqeb restart
		wait_healthy /var/log/raaqeb/raaqeb.log
		;;
	*)
		say "no systemd or OpenRC here, so no service was written. Start Raaqeb as the raaqeb user:"
		say "  RAAQEB_DATA_DIR=$data_dir $bin serve"
		return
		;;
	esac

	listen=$(listen_address)
	say "Raaqeb is running and answers at http://$listen."
	say "Next: put a reverse proxy in front of it (Caddy, Nginx or Traefik; https://raaqeb.dev/en/docs/operate/reverse-proxy),"
	say "or set RAAQEB_HOST=0.0.0.0 in $env_file and restart the service."
	say "Then open its address in a browser to finish setup. From another machine over SSH:"
	say "  ssh -L 3000:$listen <this server>, then open http://127.0.0.1:3000"
}

main "$@"
