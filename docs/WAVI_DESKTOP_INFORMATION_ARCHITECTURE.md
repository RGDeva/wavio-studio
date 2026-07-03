# Wavi Studio — Desktop Information Architecture

Principle: organize by **user jobs** (make, share, collaborate, find), not internal systems (queues, watchers, associations). Fix structure before styling.

## 1. Audit of current screens (12 pages + windows)

| Screen | Job it serves | Verdict |
|---|---|---|
| `Dashboard.tsx` | "my projects" | **Keep → becomes Projects.** Currently mixes project list, sync rows, per-row actions. |
| `LibraryPage.tsx` | "my files" | **Keep → Library.** |
| `SearchPage.tsx` | "find a file" | **Merge into Library** (search is a mode of Library, not a place). Duplicated actions: open/reveal exist in both Search and Library rows. |
| `FoldersPage.tsx` | "what does Wavi watch" | **Merge into Settings → Folders.** Watching is configuration, not a daily job. Must gain the sample-library confirmation dialog (sync review D1). |
| `FileReviewPage.tsx` | confirm file→project association | **Merge as inbox card into Home.** A review queue is not a destination; it's a notification. |
| `AbletonPage.tsx` | DAW-specific status | **Remove as nav item.** DAW state belongs on each Project Detail (compatibility chip) and Settings → DAWs. A per-DAW page contradicts the adapter model. |
| `StudioSyncPage.tsx` | inspect sync queue | **Demote → Activity tab / status popover.** Users should meet sync as a status ("Syncing 12…"), not a table of queue rows. |
| `CopilotPage.tsx` | assistant | **Keep → Copilot** (plus the existing overlay). |
| `ActivityPage.tsx` | what happened | **Keep (secondary).** |
| `DiagnosticsPage.tsx` | support/debug | **Keep (secondary), hide behind Settings → Advanced.** |
| `SettingsPage.tsx` | config | **Keep.** Gains Folders, DAWs, Sync controls (pause/resume already landing there on the sync branch). |
| `LoginPage.tsx` | auth | Keep. |
| `RestoreWindow.tsx` | receive a Project Link | Keep (windowed flow is right). |
| `ProjectDetail.tsx` (untracked WIP) | one project | **Finish — this is the centerpiece.** |
| Missing | Links management | **New: Links.** Today revocation has *no persistent UI* (a temp debug UI was built and reverted during release testing — that gap is now a product requirement, not a hack). |
| Missing | Collaborate | **New (later phase):** invites, shared-with-me, child versions. |

## 2. Proposed navigation (evaluated: adopt with one change)

Primary: **Home · Projects · Library · Links · Copilot** — and **Collaborate** joins primary only when collaborator flows exist (Phase 10); shipping an empty Collaborate tab teaches users to ignore nav. Secondary: Activity · Settings (Diagnostics inside Settings → Advanced).

- **Home** = "what needs me": review-queue cards (from FileReviewPage), sync attention items (Needs Attention / Missing Files), recent projects, recent activity digest. Empty state = onboarding checklist (connect folder, open first project, publish, share).
- **Projects** = Dashboard list, default sort recent-activity; row = name, DAW badge, status chip, last bounce play button.
- **Library** = files + search + filters (absorbs SearchPage).
- **Links** = every link (unified model), with kind, views, active/revoked, revoke button.
- **Copilot** = page + global overlay.

## 3. Project Detail (the primary screen)

Layout top-to-bottom: (1) header — name, DAW badge, status chip, collaborator avatars; (2) hero row — **playable latest bounce** + `Open in DAW` + `Publish Version` + `Create Project Link`; (3) tabs — **Versions** (history w/ parent ancestry, compare, restore), **Files** (per-file status, reveal, roles), **Links** (project-scoped), **Activity**, **Compatibility** (plugin deps, target-DAW report); (4) persistent Copilot chip ("Ask about this project"). The untracked `ProjectDetail.tsx` WIP is the starting point; route it from Projects rows.

## 4. Status language (user-facing statuses replace internal vocabulary)

| User status | Internal truth today |
|---|---|
| **Ready** | synced / idle |
| **Syncing** | pending + uploading + retrying (count, progress) |
| **Paused** | paused:user ("finishing current uploads" during drain) |
| **Needs Attention** | failed after retries; auth/limit pauses ("Sign in again", "Storage full") |
| **Missing Files** | local_status=missing aggregates |
| **Offline** | no network; queued work waiting |
| **Compatibility Warning** | adapter validate() flags (plugins missing, version skew) |

Users must never see: cloud IDs, queue row IDs, raw hashes, presign/confirm stages, "watcher", "association queue", "upsert", "requeue". These words currently leak in StudioSyncPage, Diagnostics (fine — it's a debug surface), and some toasts. `SyncStatusBadge`'s new hover explanations are the right pattern; extend it, and map `retrying → Syncing` (users shouldn't distinguish retry from upload), `cancelled → shown only in Activity`.

## 5. Gaps found

- **Empty states:** Dashboard/Library/Search have minimal or no empty states; no first-run onboarding exists at all (folder auto-discovery just happens — which, combined with sample-library protection, now *requires* an explicit consent moment).
- **Duplicated actions:** open/reveal in Search + Library; sync-now exists in tray, StudioSync, and Settings with different semantics (`sync:now` also retries all failures — see sync review S5).
- **Terminology drift:** "Studio Sync" vs "Sync" vs "Cloud"; "Share Link" vs "Project Link" vs "Listen Link" — adopt: **Link** (kinds: Listen, Project) everywhere.
- **Desktop vs browser responsibilities:** Desktop = local files, DAWs, publishing, restore, Copilot-with-tools. Browser (wavio) = receiving links, listening, commenting, paywall/marketplace, account. Mobile (future) = listen/comment/approve only. Do not build listening-destination features into desktop or file-management into web.

## 6. Sequence

1. Land D1 confirmation dialog (with sync branch merge).
2. Route ProjectDetail; hero row uses existing publish/link/restore IPC.
3. Nav restructure (merge Search→Library, Folders→Settings, FileReview→Home cards; add Links page — first persistent revoke UI).
4. Status-language pass over badges/toasts/tray.
5. Empty states + onboarding checklist.
Visual redesign comes after all five.
