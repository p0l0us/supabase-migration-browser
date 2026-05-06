# Browse Supabase Migrations

This standalone VS Code extension adds a read-only Supabase RPC and view browser for SQL files in `supabase/migrations`.

## What It Does

- Scans `supabase/migrations/*.sql` files from the target workspace.
- Extracts RPC function and view names exactly as they are declared in SQL.
- Shows each RPC or view only once, using the newest migration that defines or replaces it.
- Caches parsed SQL object definitions and target-branch migration snapshots so refreshes avoid reprocessing unchanged historical migrations.
- Persists the cache in each workspace at `.vscode/supabase-migration-browser-cache.json`, allowing cached migration data to be reused after VS Code restarts.
- Validates parsed workspace migration cache entries with SHA-256 content hashes and target-branch snapshots with the selected comparison ref plus immutable Git merge-base commit.
- Filters the list by all objects, RPCs only, or views only.
- Keeps Git change detection disabled by default so initial browsing does not run Git comparison checks.
- Provides a `Detect git changes` checkbox that enables local Git comparison against remote-tracking refs.
- Shows only new or updated RPCs/views when Git change detection is enabled, with a checkbox to include unchanged objects when needed.
- Lists origin branches after Git change detection is enabled so you can choose which target branch to compare migrations against.
- Populates the branch selector before the full migration comparison finishes and keeps branch, filter, and checkbox controls usable during loading.
- Restarts loading with the latest branch, filter, and checkbox state when those controls change during an in-flight refresh.
- Selects the current branch base by default when that metadata is available, otherwise falls back to the origin default branch.
- Compares the current workspace against the selected target branch so the list knows which objects were changed in this branch.
- Automatically refreshes and reselects the branch base when the current Git branch changes and Git change detection is enabled.
- Sorts branch-changed objects to the top of the list, then keeps alphabetical ordering within each change group.
- Displays the timestamp of the latest migration that edited the object.
- Uses yellow rows for updated objects and green rows for newly introduced objects while leaving unchanged objects with the default styling.
- Adds its own Activity Bar icon so the object browser is visible in the left sidebar.
- Opens a side-by-side diff whenever a previous workspace definition or target-branch comparison definition exists.
- Shows a compact comparison menu next to the Diff button so a specific related migration can be selected as the diff base for the current RPC/view definition.
- Shows a compact current-migration selector next to the displayed migration path when an object has more than two workspace versions, excluding the oldest version because it has no earlier workspace version to compare from.
- Filters the diff-base menu to migrations older than the selected current migration so diff direction cannot be accidentally reversed.
- Opens the latest migration file by default for new objects and any object without a diffable previous definition.
- Shows inline row actions for opening the latest migration file, the previous workspace migration defining the object when one exists, and a generated related-queries view.
- The related-queries view groups helper SQL by migration, wraps each migration block with begin/end comments, and inserts RPC/view version markers where each object definition appears among the helper queries.
- Keeps a permanent search field pinned at the top of the sidebar and still lets the toolbar search action focus that field.
- Makes search and RPC/view filtering respect the active changed-only and comparison-branch controls.
- Adds a refresh action to reload the list and shows a loading state while refreshed data is being read.
- Shows detailed loading status at the bottom of the panel with Git/cache/file-reading phases and percentage progress when the total number of migrations is known.
- Shows a clear empty state when the migrations folder is missing or no RPCs/views are defined.

## Scope

This extension is intentionally read-only. It does not create, edit, apply, or delete migrations.

## Run And Debug Locally

1. Change into this package:

   ```bash
   cd /Users/polehla/vscode/supabase-migration-browser
   ```

2. Install the package-local development dependencies:

   ```bash
   npm install
   ```

3. Open this folder in VS Code.
4. Run the `Run Browse Supabase Migrations` launch configuration or press `F5`.

In the Extension Development Host, click the `Supabase Objects` icon in the Activity Bar to open the RPC/view browser.

The extension host opens the repository root as the workspace so the view can browse the real `supabase/migrations` folder.

## Validation

```bash
npm run compile
npm run test
npm run package:vsix
```