---
status: accepted
---

# Check reasons are codes with parameters, and page contents are stored only by opt-in capture

A check's reason is an integer code from a closed dictionary in code plus a small parameter object (expected and observed values), rendered through the message catalog in the reader's locale. The raw runtime error string is kept beside a failed check, capped at 256 characters, as a machine token, never as the reason itself. Response headers and body are never stored on the success path and never stored at all unless the monitor's capture mode is on failure or always, and then as headers plus the first 4 KB, with cookie and credential headers reduced to their names. Request headers and the monitor's credentials are never written to any check record.

## Why

- Using the runtime string ("getaddrinfo ENOTFOUND host") as the reason would show text that can never be in Arabic. Raaqeb is Arabic-first, and a reason is the one string an operator reads at three in the morning.
- Every tool examined discards bodies and headers on success; the ones that keep them on failure truncate hard. Bodies on every check at 60 s would add gigabytes per monitor per quarter and put stack traces and credentials from error pages into the database.
- Defaults should be good and the risk left to the operator: capture exists, per monitor, off by default, with its disk cost shown beside the "always" choice.

## Consequences

- Adding a reason means adding a code and an Arabic and an English catalog message in the same pull request. Every check type maps its runtime errors onto the dictionary; an unmapped error becomes a generic code with the raw string beside it.
- Reasons are stable across versions: a code is never renumbered, only added or retired.
- The check row stays small on SQLite (about 68 bytes with the text UUID monitor id); the failure record and captures are separate so the row size does not depend on the capture mode.
