# Specs - Browse Supabase RPCs In VS Code

## Task Summary

Create a VS Code extension that lets developers browse Supabase RPC functions directly from the workspace, without manually navigating the file tree. The extension should discover SQL migrations under the workspace `supabase/migrations` folder, extract RPC definitions, show which RPCs changed in the current branch, and make it easy to inspect both the latest migration source and the latest-vs-previous RPC diff.

## Requirements

- The extension must discover SQL migration files located in the workspace `supabase/migrations` folder.
- The extension must extract RPC functions from discovered SQL migration files and show them in a dedicated VS Code view.
- The extension must compare the current workspace against the current branch base to determine which RPC functions changed in the branch.
- The extension must sort RPCs changed in the current branch to the top of the list.
- The extension must distinguish unchanged, updated, and new RPC rows with consistent styling: unchanged uses the default styling, updated uses yellow, and new uses green.
- The extension must show a readable RPC label and the latest migration timestamp so developers can distinguish entries quickly.
- The extension must open the latest migration file in the editor when a user chooses that action from the list.
- The extension must open a diff between the latest and previous RPC SQL definitions when a user selects an RPC from the list.
- The extension must provide a refresh action so the list can be updated after files are added, removed, or renamed.
- The extension must provide live search across RPC names, migration paths, and SQL text.
- The extension must show a clear empty state when no `supabase/migrations` folder or no RPC definitions are found in the workspace.
- The extension must remain read-only for this task; creating, editing, applying, or deleting migrations is out of scope.

## Acceptance Criteria (Gherkin)

**Feature:** Browse Supabase RPCs directly in VS Code
  To inspect database function changes quickly from the editor
  As a developer working in the repository
  I want a dedicated VS Code view that lists the Supabase RPCs from my workspace.

  **Scenario:** Browse all RPCs from the workspace
    **Given** my workspace contains SQL migration files in `supabase/migrations`
    **When** I open the Supabase RPCs view in VS Code
    **Then** I can see each discovered RPC function from that folder

  **Scenario:** Prioritize RPCs changed in the current branch
    **Given** my current branch changes one or more RPC functions relative to its branch base
    **When** I open the Supabase RPCs view in VS Code
    **Then** RPCs changed in the current branch appear before unchanged RPCs

  **Scenario:** Color-code RPC rows by change type
    **Given** the Supabase RPCs view shows unchanged, updated, and new RPCs
    **When** I browse the list
    **Then** unchanged RPCs keep the default styling
    **And** updated RPCs are shown in yellow
    **And** new RPCs are shown in green

  **Scenario:** Open the latest-vs-previous RPC diff from the browser view
    **Given** the Supabase RPCs view shows one or more RPCs
    **When** I select an RPC from the list
    **Then** a diff between the latest and previous SQL definitions opens in the editor

  **Scenario:** Open the latest migration source from the browser view
    **Given** the Supabase RPCs view shows one or more RPCs
    **When** I trigger the open-source action for an RPC
    **Then** the corresponding SQL migration file opens in the editor at the RPC definition

  **Scenario:** Refresh the RPC list after files change
    **Given** the Supabase RPCs view is open
    **When** a migration file is added, removed, or renamed in `supabase/migrations`
    **And** I refresh the Supabase RPCs view
    **Then** the list reflects the current contents of the folder

  **Scenario:** Handle a workspace without RPCs
    **Given** my workspace does not contain any SQL migration files in `supabase/migrations`
    **When** I open the Supabase RPCs view in VS Code
    **Then** I see a clear empty state explaining that no Supabase RPCs were found