# Browse Supabase Migrations

This standalone VS Code extension adds a read-only Supabase RPC and view browser for SQL files in `supabase/migrations`.

## What It Does

- Scans `supabase/migrations/*.sql` files from the target workspace.
- Extracts RPC function and view names exactly as they are declared in SQL.
- Shows each RPC or view only once, using the newest migration that defines or replaces it.
- Filters the list by all objects, RPCs only, or views only.
- Compares the current workspace against the current branch base so the list knows which objects were changed in this branch.
- Sorts branch-changed objects to the top of the list, then keeps alphabetical ordering within each change group.
- Displays the timestamp of the latest migration that edited the object.
- Uses yellow rows for updated objects and green rows for newly introduced objects while leaving unchanged objects with the default styling.
- Adds its own Activity Bar icon so the object browser is visible in the left sidebar.
- Opens a side-by-side diff between the latest and previous SQL definitions when a comparison version exists and the object is not new in the current branch.
- Opens the latest migration file by default for new objects and any object without a diffable previous definition.
- Shows inline row actions for opening the latest migration file, the previous migration defining the object, and a generated related-queries view.
- The related-queries view groups helper SQL by migration, wraps each migration block with begin/end comments, and inserts RPC/view version markers where each object definition appears among the helper queries.
- Keeps a permanent search field pinned at the top of the sidebar and still lets the toolbar search action focus that field.
- Adds a refresh action to reload the list.
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