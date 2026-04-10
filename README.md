# Browse Supabase Migrations

This standalone VS Code extension adds a read-only Supabase RPC browser for SQL files in `supabase/migrations`.

## What It Does

- Scans `supabase/migrations/*.sql` files from the target workspace.
- Extracts RPC function names exactly as they are declared in SQL.
- Shows each RPC only once, using the newest migration that defines or replaces it.
- Compares the current workspace against the current branch base so the list knows which RPCs were changed in this branch.
- Sorts branch-changed RPCs to the top of the list, then keeps alphabetical ordering within each change group.
- Displays the timestamp of the latest migration that edited the RPC.
- Uses yellow rows for updated RPCs and green rows for newly introduced RPCs while leaving unchanged RPCs with the default styling.
- Adds its own Activity Bar icon so the RPC browser is visible in the left sidebar.
- Opens a side-by-side diff between the latest and previous SQL definitions when a comparison version exists and the RPC is not new in the current branch.
- Opens the latest migration file by default for new RPCs and any RPC without a diffable previous definition.
- Shows inline row actions for opening the latest migration file, the previous migration defining the RPC, and a generated related-queries view for non-function SQL in the latest migration, with diff only when a comparison definition exists.
- Adds a live full-text search action in the view toolbar that filters while you type.
- Adds a refresh action to reload the list.
- Shows a clear empty state when the migrations folder is missing or no RPCs are defined.

## Scope

This extension is intentionally read-only. It does not create, edit, apply, or delete migrations.

## Run And Debug Locally

1. Change into this package:

   ```bash
   cd /Users/polehla/vscode/suabase-migration-browser
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
npm run package:vsix
```