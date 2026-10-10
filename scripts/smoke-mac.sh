#!/bin/sh
# Raaqeb's smoke test on a Mac with Apple Silicon, run by hand on a
# real Mac. From the folder holding raaqeb-darwin-arm64, SHA256SUMS and
# install.sh:
#
#   sh smoke-mac.sh            the binary alone, no sudo
#   sh smoke-mac.sh --install  then the installer, its launchd daemon and
#                              its uninstall (asks for sudo; leaves nothing)
#
# Every check prints PASS or FAIL; the last line is the result to paste back.
# RAAQEB_BIN names another binary, so the script runs on Linux too.
set -u

here=$(cd "$(dirname "$0")" && pwd)
bin=${RAAQEB_BIN:-$here/raaqeb-darwin-arm64}
passed=0
failed=0

pass() {
	passed=$((passed + 1))
	printf 'PASS %s\n' "$1"
}

fail() {
	failed=$((failed + 1))
	printf 'FAIL %s\n' "$1"
}

# Runs the command after the name and passes when it exits 0.
check() {
	name=$1
	shift
	if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

# The HTTP status of a GET, redirects not followed.
status_of() {
	curl -s -o /dev/null -w '%{http_code}' "$1"
}

# Waits up to the seconds given for /health at the port to answer 200.
wait_health() {
	tries=0
	until curl -fsS "http://127.0.0.1:$1/health" >/dev/null 2>&1; do
		tries=$((tries + 1))
		[ "$tries" -ge "$2" ] && return 1
		sleep 1
	done
}

printf 'INFO macOS %s, %s, %s\n' "$(sw_vers -productVersion 2>/dev/null || uname -sr)" "$(uname -m)" "$(basename "$bin")"

# The binary: its checksum, its signature, the quarantine flag.
check "the binary matches SHA256SUMS" sh -c "cd '$here' && grep ' $(basename "$bin")\$' SHA256SUMS | shasum -a 256 -c -"
if command -v codesign >/dev/null 2>&1; then
	check "the binary carries a valid signature" codesign --verify --strict "$bin"
	check "the signature is ad hoc" sh -c "codesign -dv '$bin' 2>&1 | grep -q 'Signature=adhoc'"
	if xattr -p com.apple.quarantine "$bin" >/dev/null 2>&1; then
		printf 'INFO the binary carries the quarantine flag (a browser download); removing it\n'
		xattr -d com.apple.quarantine "$bin"
	else
		printf 'INFO the binary carries no quarantine flag\n'
	fi
fi
chmod +x "$bin"

# A free port and a data directory holding an empty SQLite file, which serve
# migrates, so the write-ahead log exists while it runs.
port=39309
while curl -s -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; do
	port=$((port + 1))
done
tmp=$(mktemp -d)
mkdir -m 700 "$tmp/data"
: >"$tmp/data/raaqeb.sqlite"

RAAQEB_DATA_DIR=$tmp/data RAAQEB_PORT=$port "$bin" serve >"$tmp/log" 2>&1 &
pid=$!
check "serve answers /health within 60 seconds" wait_health "$port" 60
check "/health reports the database and the scheduler ok" sh -c "curl -fsS http://127.0.0.1:$port/health | grep -q '\"ok\":true'"
check "/ sends a fresh install to onboarding" test "$(status_of "http://127.0.0.1:$port/")" = 307
curl -s "http://127.0.0.1:$port/onboarding" >"$tmp/page.html"
check "the onboarding page renders in Arabic, right to left" grep -q 'dir="rtl"' "$tmp/page.html"
asset=$(grep -a -o '/assets/[^"]*\.js' "$tmp/page.html" | head -n 1)
check "an embedded client asset answers 200" test "$(status_of "http://127.0.0.1:$port$asset")" = 200
check "/admin sends a fresh install to onboarding" test "$(status_of "http://127.0.0.1:$port/admin")" = 307
check "raaqeb health exits 0" env RAAQEB_PORT="$port" "$bin" health
check "the write-ahead log exists while serve runs" test -e "$tmp/data/raaqeb.sqlite-wal"

# Ctrl+C is SIGINT; a watchdog kills a server that does not stop.
kill -INT "$pid"
(sleep 30 && kill -9 "$pid" 2>/dev/null) &
watchdog=$!
wait "$pid"
code=$?
kill "$watchdog" 2>/dev/null
check "Ctrl+C (SIGINT) stops serve with exit 0" test "$code" = 0
check "serve logged its stop" grep -q 'raaqeb: stopping' "$tmp/log"
check "the stop checkpointed the write-ahead log" test ! -e "$tmp/data/raaqeb.sqlite-wal"
check "the stop left no shared-memory file" test ! -e "$tmp/data/raaqeb.sqlite-shm"
check "the data directory holds config.json, raaqeb.sqlite and snapshots alone" test "$(ls -A "$tmp/data" | tr '\n' ' ')" = "config.json raaqeb.sqlite snapshots "
rm -rf "$tmp"

if [ "${1:-}" = --install ]; then
	plist=/Library/LaunchDaemons/raaqeb.plist
	if [ -e "$plist" ]; then
		fail "no Raaqeb is installed here before the test ($plist exists; uninstall it first)"
	elif curl -s -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
		fail "port 3000 is free for the installed daemon"
	else
		printf 'INFO installing with sudo; the uninstall at the end removes everything\n'
		check "install.sh installs and starts the daemon" sudo env RAAQEB_DOWNLOAD_URL="file://$here" sh "$here/install.sh"
		check "launchd runs the daemon" sh -c "sudo launchctl print system/raaqeb | grep -q 'state = running'"
		check "raaqeb health exits 0" /usr/local/bin/raaqeb health
		check "the data directory is the _raaqeb user's, mode 700" test "$(stat -f '%Su %Lp' /usr/local/var/raaqeb)" = "_raaqeb 700"
		check "the env file is root:_raaqeb, mode 640" test "$(sudo stat -f '%Su:%Sg %Lp' /usr/local/etc/raaqeb/raaqeb.env)" = "root:_raaqeb 640"
		check "the install key was generated into the data directory" sudo test -e /usr/local/var/raaqeb/config.json
		old=$(pgrep -x raaqeb | head -n 1)
		check "the daemon runs as _raaqeb" test "$(ps -o user= -p "$old" | tr -d ' ')" = _raaqeb
		sudo kill -9 "$old"
		sleep 2
		check "launchd starts the daemon again after it is killed" wait_health 3000 60
		check "the new process is another one" test "$(pgrep -x raaqeb | head -n 1)" != "$old"
		check "the log has lines" sudo test -s /usr/local/var/log/raaqeb/raaqeb.log

		# The uninstall, line for line as website/content/docs/operate/uninstall.en.mdx gives it (scripts/install.test.ts holds them equal).
		sudo sh -c 'launchctl bootout system/raaqeb && rm /Library/LaunchDaemons/raaqeb.plist /usr/local/bin/raaqeb'
		sudo sh -c 'rm -r /usr/local/etc/raaqeb /usr/local/var/raaqeb /usr/local/var/log/raaqeb'
		sudo sh -c 'dscl . -delete /Users/_raaqeb && dscl . -delete /Groups/_raaqeb'
		sleep 2
		check "after the uninstall launchd knows no daemon" sh -c "! sudo launchctl print system/raaqeb"
		check "after the uninstall no raaqeb process runs" sh -c "! pgrep -x raaqeb"
		check "after the uninstall no file is left" sh -c "! ls -d $plist /usr/local/bin/raaqeb /usr/local/var/raaqeb /usr/local/etc/raaqeb /usr/local/var/log/raaqeb 2>/dev/null | grep -q ."
		check "after the uninstall no _raaqeb user or group is left" sh -c "! dscl . -read /Users/_raaqeb && ! dscl . -read /Groups/_raaqeb"
	fi
fi

if [ "$failed" -eq 0 ]; then
	printf 'RESULT: PASS (%s checks)\n' "$passed"
else
	printf 'RESULT: FAIL (%s of %s checks failed)\n' "$failed" "$((passed + failed))"
	exit 1
fi
