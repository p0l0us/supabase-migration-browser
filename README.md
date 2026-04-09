# Browse Supabase Migrations

This standalone VS Code extension adds a read-only Supabase RPC browser for SQL files in `supabase/migrations`.

## What It Does

- Scans `supabase/migrations/*.sql` files from the target workspace.
- Extracts RPC function names exactly as they are declared in SQL.
- Shows each RPC only once, using the newest migration that defines or replaces it.
- Sorts the RPC list alphabetically.
- Displays the timestamp of the latest migration that edited the RPC.
- Uses a different RPC icon when the newest definition is still uncommitted, distinguishing newly introduced RPCs from updated ones.
- Adds its own Activity Bar icon so the RPC browser is visible in the left sidebar.
- Opens a side-by-side diff between the latest and previous SQL definitions for the selected RPC.
- Shows inline row actions for diffing the RPC and opening the latest migration file at the RPC definition.
- Adds a live full-text search action in the view toolbar that filters while you type.
- Adds a refresh action to reload the list.
- Shows a clear empty state when the migrations folder is missing or no RPCs are defined.

## Scope

This extension is intentionally read-only. It does not create, edit, apply, or delete migrations.

## Run And Debug Locally

1. Change into this package:

   ```bash
   cd vscode-extensions/browse-supabase-migrations
   ```

2. Install the package-local development dependencies:

   ```bash
   npm install
   ```

3. Open this folder in VS Code.
4. Run the `Run Browse Supabase Migrations` launch configuration or press `F5`.

In the Extension Development Host, click the `Supabase RPCs` icon in the Activity Bar to open the RPC browser.

The extension host opens the repository root as the workspace so the view can browse the real `supabase/migrations` folder.

## Validation

```bash
npm run compile
npm run test
```