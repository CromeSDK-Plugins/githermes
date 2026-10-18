# Agent notes

## Version bump

Jeder Patch zählt die Version passend hoch (SemVer: Patch für Bugfixes, Minor für Features, Major für Breaking Changes) – an allen Stellen, an denen die Version geführt wird.

The version is recorded in:

- `package.json` (`version`)
- `plugin.yaml` (`version`)
- `README.md` (opening version line)
- `test/sdk_compatibility.test.js` (assertions that keep those values aligned)

When `CHANGELOG.md` exists, add an entry for the change.
