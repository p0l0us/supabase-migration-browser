# Plan - Browse Supabase RPCs In VS Code

## Scope

Build a read-only VS Code extension that browses Supabase RPCs extracted from SQL migration files in the workspace `supabase/migrations` folder, highlights which RPCs changed in the current branch, and opens selected RPC diffs or source definitions in the editor. This task covers browsing and inspection only.

## Feature Overview

The repository currently stores Supabase RPC definitions inside `supabase/migrations`, but developers must inspect branch changes manually through raw SQL files and git history. The extension should provide a focused Supabase RPC browser inside VS Code, compare the current workspace to the current branch base, surface changed RPCs at the top, color-code new versus updated entries, and refresh when migration files change.

## Acceptance Criteria Summary

- The extension lists all RPCs extracted from SQL migrations found in `supabase/migrations`.
- RPCs changed in the current branch appear before unchanged RPCs.
- New RPC rows are green and updated RPC rows are yellow.
- Selecting an RPC opens a latest-vs-previous SQL diff.
- The latest migration source can be opened directly from the row actions.
- The view can be refreshed after migration files change.
- A clear empty state is shown when no migrations are available.

## Database Changes

- No database schema changes.
- No Supabase RPC changes shipped by this task. The extension only inspects them.

## Supabase Edge Function Updates

- No Supabase Edge Function changes.

## Likely Implementation Areas

- Implement migration file discovery for `supabase/migrations` using the VS Code workspace APIs.
- Implement RPC extraction, branch-base comparison, and change classification for current branch visibility.
- Implement list ordering that keeps changed RPCs above unchanged RPCs.
- Implement a tree view provider that renders color-coded RPC rows in a dedicated VS Code view.
- Implement commands for refresh, RPC diff, source-file open, and search.
- Add minimal extension documentation describing how to run and package the extension locally.
- Add focused unit tests for branch comparison, sorting, and label formatting logic.

## Unit Test Strategy

- Add unit tests for migration filename parsing and RPC extraction.
- Add unit tests for branch-base comparison so `new`, `updated`, and unchanged statuses are deterministic.
- Add unit tests for list ordering so changed RPCs appear before unchanged RPCs.
- Add unit tests for migration discovery behavior when the folder is present, empty, or missing.
- Target coverage for the pure extension logic introduced by this task rather than the VS Code runtime itself.

## Manual Testing

1. Open the repository in VS Code with a populated `supabase/migrations` folder.
2. Launch the extension in the VS Code extension host.
3. Open the Supabase RPCs view and verify all discovered RPCs are listed.
4. Verify RPCs changed in the current branch appear above unchanged RPCs.
5. Verify updated RPCs are yellow and new RPCs are green.
6. Select several RPCs and verify the correct latest-vs-previous SQL diff opens.
7. Trigger the open-source action and verify the correct SQL file opens at the RPC definition.
8. Add, rename, and remove a migration file under `supabase/migrations`, then refresh the view and verify the list updates correctly.
9. Test against a workspace with no `supabase/migrations` folder or no RPCs and verify the empty state is shown.

## Estimate

- T-shirt size: M
- Approximate file count: 8 to 10 files
- Subtasks needed: No

## Task Checklist

- [ ] Confirm task name and scope
- [ ] Implement migration discovery for `supabase/migrations`
- [ ] Implement RPC extraction and branch-base comparison
- [ ] Implement changed-first sorting and row color coding
- [ ] Implement the VS Code RPC browser view
- [ ] Implement diff, open-source, search, and refresh commands
- [ ] Add unit tests for branch comparison, sorting, and labels
- [ ] Add extension usage documentation
- [ ] Run validation for the extension changes

## Outstanding Questions And Resolutions

- Extension behavior: Resolved as read-only RPC inspection only. Editing, creating, applying, and deleting migrations are out of scope for this task.
- Branch comparison baseline: Resolved as the merge-base between `HEAD` and the best available mainline reference, falling back to `HEAD` when no base branch reference is available.
- Folder scope: Resolved to the workspace `supabase/migrations` folder, matching the repository structure used in this codebase.