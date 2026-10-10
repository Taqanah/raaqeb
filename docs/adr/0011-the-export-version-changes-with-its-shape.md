---
status: accepted
---

# The export's version changes with its shape

The export's first line carries `version` (`exportVersion` in `src/shared/schemas/export.ts`). An import reads it before anything else and refuses a file whose version is not its own, naming the reason. Any change to the shape of the export, in its header or in its history lines, raises `exportVersion` in the same pull request. Version 1 is the shape the first release ships.

## Why

- The version is the only thing that lets an install tell an operator "this file is from another version of Raaqeb". A shape change that keeps the number passes that check and then fails on the first field that moved, which reads as a corrupt file ("invalid at line 1"), or worse, imports data into the wrong place.
- An export is how an operator moves between hosts or backends and how many keep backups, so it outlives the install that wrote it. An operator may import a file months after writing it, into a newer or an older Raaqeb.
- Before the first release no operator holds an export, so the shapes before it need no number of their own.

## Consequences

- A pull request that changes `src/shared/schemas/export.ts` in a way that changes what a file holds raises `exportVersion`; a pull request that only renames a type or adds a comment does not.
- The release runbook checks it: when the export schema changed since the previous release and `exportVersion` did not, the release stops.
- An import accepts only its own version. Reading an older version, converting it on the way in, is a feature for when operators need it, not a promise this record makes.
