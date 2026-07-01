# Future folder-grouping safety requirements

## Current heuristic (DO NOT SHIP)

`groupDiscoveredFilesByFolder()` in `electron/db.ts` groups any parent directory
containing ≥2 discovered audio files into a virtual project named after that folder.

**This heuristic is unsafe and must not be shipped.**

## Why the heuristic is wrong

The following directories all contain multiple audio files but are NOT projects:

| Directory type | Example | Why not a project |
|---|---|---|
| Sample library | `~/Music/Splice/` | Thousands of unrelated samples |
| Drum kit | `~/Downloads/DrumKit808/` | Flat collection, no DAW context |
| Download folder | `~/Downloads/` | Random mixed content |
| Stem library | `~/Music/Stems/Artist/` | Pre-made stems, not a DAW project |
| Plugin content | `~/Library/Audio/Plug-Ins/…/Samples/` | Plugin-managed, read-only |
| Export folder | `~/Desktop/Exports/` | Render outputs from multiple sessions |
| Desktop audio collection | `~/Desktop/` | Ad-hoc placement, no relationship |

Applying the ≥2 heuristic to any of these creates hundreds of spurious "projects",
pollutes the Library, and corrupts the Copilot's context with noise.

## Required evidence for safe auto-grouping

A directory must satisfy at least ONE of the following before being created as a project:

1. **DAW project file present** — directory contains a `.als`, `.flp`, `.logic`,
   `.ptx`, `.npr`, `.reason`, `.song`, `.cpr`, or similar DAW-native project file.

2. **Known project-directory structure** — directory matches a well-known layout:
   - Ableton: contains `Ableton Project Info/` subdirectory
   - Logic: is a `.logicx` bundle
   - FL Studio: contains `[project name].flp` at root

3. **Explicit user confirmation** — user has selected the directory as a project root
   via the UI, or Wavi's folder-watcher detected a DAW project file.

4. **Trusted project-root metadata** — directory already has an entry in the
   `projects` table (e.g., it was previously synced through Wavi).

## Recommended implementation path

- Add a `hasProjectFile(dir)` check before `groupDiscoveredFilesByFolder()`.
- Only promote directories that contain a recognized DAW project file.
- For the "same name+date" grouping specifically: limit scope to files whose
  names share a common prefix (e.g., stem naming conventions) AND whose
  `modified_at` values are within a 1-hour window — not just any co-located files.
- Always require a user-visible confirmation step before writing project rows
  from auto-discovery.

## Status

`groupDiscoveredFilesByFolder()` is committed on `feature/copilot-semantic-discovery`
for future reference. It has been reverted from `feature/ableton-daw-companion`
and must not be merged or re-introduced without addressing the above requirements.
