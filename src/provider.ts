import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { parseGitPathList } from './git-status';
import {
  buildMigrationModels,
  canOpenRpcDiff,
  filterMigrationModels,
  getEmptyState,
  getSearchEmptyState,
  hasLatestMigrationRelatedQueries,
  hasComparisonMigration,
  type EmptyStateModel,
  type MigrationFileDescriptor,
  type MigrationModel,
  type RpcChangeState,
} from './migrations';

const execFileAsync = promisify(execFile);
export const RPC_TREE_ITEM_SCHEME = 'supabase-rpc-item';

type SupabaseMigrationsTreeItem =
  | MigrationTreeItem
  | EmptyStateTreeItem;

type ProviderState = {
  emptyState: EmptyStateModel | null;
  includeWorkspaceName: boolean;
  items: MigrationModel[];
};

export class MigrationTreeItem extends vscode.TreeItem {
  readonly model: MigrationModel;
  readonly uri: vscode.Uri;

  constructor(model: MigrationModel, includeWorkspaceName: boolean) {
    super(model.label, vscode.TreeItemCollapsibleState.None);

    this.model = model;
    this.id = model.id;
    this.uri = vscode.Uri.parse(model.uriString);
    this.resourceUri = buildTreeItemResourceUri(model);
    this.contextValue = buildContextValue(model);
    this.description = buildDescription(model, includeWorkspaceName);
    this.iconPath = buildIcon(model.changeState);
    this.tooltip = buildTooltip(model);
    this.command = buildPrimaryCommand(model, this);
  }
}

class EmptyStateTreeItem extends vscode.TreeItem {
  constructor(model: EmptyStateModel) {
    super(model.label, vscode.TreeItemCollapsibleState.None);

    this.contextValue = 'supabaseMigrationEmptyState';
    this.iconPath = new vscode.ThemeIcon('info');
    this.tooltip = model.message;
  }
}

export class SupabaseMigrationsProvider
  implements vscode.TreeDataProvider<SupabaseMigrationsTreeItem>, vscode.Disposable {
  private readonly treeDataEmitter =
    new vscode.EventEmitter<SupabaseMigrationsTreeItem | undefined | void>();
  private readonly messageEmitter = new vscode.EventEmitter<string | undefined>();
  private readonly watcher: vscode.FileSystemWatcher;
  private cachedState?: ProviderState;
  private searchQuery = '';

  readonly onDidChangeTreeData = this.treeDataEmitter.event;
  readonly onDidChangeMessage = this.messageEmitter.event;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/supabase/migrations/*.sql',
    );

    const refresh = () => {
      void this.refresh();
    };

    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete(refresh);
    this.watcher.onDidChange(refresh);
  }

  dispose(): void {
    this.cachedState = undefined;
    this.watcher.dispose();
    this.treeDataEmitter.dispose();
    this.messageEmitter.dispose();
  }

  getTreeItem(element: SupabaseMigrationsTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: SupabaseMigrationsTreeItem,
  ): Promise<SupabaseMigrationsTreeItem[]> {
    if (element) {
      return [];
    }

    const state = await this.loadState(false);

    if (state.items.length === 0 && state.emptyState) {
      return [new EmptyStateTreeItem(state.emptyState)];
    }

    return state.items.map(
      (item) => new MigrationTreeItem(item, state.includeWorkspaceName),
    );
  }

  async refresh(): Promise<void> {
    await this.loadState(true);
    this.treeDataEmitter.fire();
  }

  async setSearchQuery(searchQuery: string): Promise<void> {
    this.searchQuery = searchQuery;
    await this.loadState(true);
    this.treeDataEmitter.fire();
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  private async loadState(force: boolean): Promise<ProviderState> {
    if (!force && this.cachedState) {
      return this.cachedState;
    }

    const state = await this.readState();

    this.cachedState = state;
    this.messageEmitter.fire(state.emptyState?.message);

    return state;
  }

  private async readState(): Promise<ProviderState> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const files: MigrationFileDescriptor[] = [];
    const baseFiles: MigrationFileDescriptor[] = [];
    let hasMigrationsFolder = false;

    for (const workspaceFolder of workspaceFolders) {
      const workspaceBaseFiles = await getBaseMigrationFiles(
        workspaceFolder,
      );
      baseFiles.push(...workspaceBaseFiles);
      const migrationFolderUri = vscode.Uri.joinPath(
        workspaceFolder.uri,
        'supabase',
        'migrations',
      );

      let directoryEntries: [string, vscode.FileType][];

      try {
        directoryEntries = await vscode.workspace.fs.readDirectory(
          migrationFolderUri,
        );
        hasMigrationsFolder = true;
      } catch {
        continue;
      }

      for (const [entryName, fileType] of directoryEntries) {
        if (
          fileType !== vscode.FileType.File ||
          !entryName.toLowerCase().endsWith('.sql')
        ) {
          continue;
        }

        const fileUri = vscode.Uri.joinPath(migrationFolderUri, entryName);
        const fileContent = await vscode.workspace.fs.readFile(fileUri);
        const workspaceRelativePath = vscode.workspace.asRelativePath(fileUri, false);

        files.push({
          content: new TextDecoder().decode(fileContent),
          fileName: entryName,
          uriString: fileUri.toString(),
          workspaceRelativePath,
          workspaceFolderName: workspaceFolder.name,
        });
      }
    }

    const items = buildMigrationModels(files, baseFiles);
    const filteredItems = filterMigrationModels(items, this.searchQuery);

    const emptyState = this.searchQuery.trim()
      ? filteredItems.length === 0
        ? getSearchEmptyState(this.searchQuery.trim())
        : null
      : getEmptyState({
        hasMigrationsFolder,
        hasSqlFiles: items.length > 0,
      });

    return {
      emptyState,
      includeWorkspaceName: workspaceFolders.length > 1,
      items: filteredItems,
    };
  }
}

function buildIcon(changeState: RpcChangeState | null): vscode.ThemeIcon {
  if (changeState === 'new') {
    return new vscode.ThemeIcon(
      'diff-added',
      new vscode.ThemeColor('charts.green'),
    );
  }

  if (changeState === 'updated') {
    return new vscode.ThemeIcon(
      'diff-modified',
      new vscode.ThemeColor('charts.yellow'),
    );
  }

  return new vscode.ThemeIcon('symbol-function');
}

function buildDescription(
  model: MigrationModel,
  includeWorkspaceName: boolean,
): string {
  const descriptionParts: string[] = [];

  if (includeWorkspaceName && model.workspaceFolderName) {
    descriptionParts.push(model.workspaceFolderName);
  }

  if (model.changeState === 'new') {
    descriptionParts.push('new');
  }

  if (model.changeState === 'updated') {
    descriptionParts.push('updated');
  }

  descriptionParts.push(model.description);

  return descriptionParts.join(' · ');
}

function buildTooltip(model: MigrationModel): string {
  const tooltipLines = [
    model.label,
    `Latest: ${model.workspaceRelativePath}`,
    `Latest timestamp: ${model.description}`,
  ];

  if (model.changeState === 'new') {
    tooltipLines.push('Changed in current branch: new RPC');
  }

  if (model.changeState === 'updated') {
    tooltipLines.push('Changed in current branch: updated RPC');
  }

  if (model.comparisonVersion) {
    tooltipLines.push(
      `Previous: ${model.comparisonVersion.workspaceRelativePath}`,
      `Previous timestamp: ${model.comparisonVersion.timestamp ?? model.comparisonVersion.fileName}`,
    );
  } else {
    tooltipLines.push('Previous: no previous version found');
  }

  return tooltipLines.join('\n');
}

function buildTreeItemResourceUri(model: MigrationModel): vscode.Uri {
  return vscode.Uri.from({
    scheme: RPC_TREE_ITEM_SCHEME,
    path: `/${encodeURIComponent(model.id)}`,
    query: `state=${model.changeState ?? 'unchanged'}`,
  });
}

function buildContextValue(model: MigrationModel): string {
  const contextParts = ['supabaseMigration'];

  if (canOpenRpcDiff(model)) {
    contextParts.push('canDiff');
  }

  if (hasComparisonMigration(model)) {
    contextParts.push('hasPrevious');
  }

  if (hasLatestMigrationRelatedQueries(model.latestVersion)) {
    contextParts.push('hasRelatedQueries');
  }

  return contextParts.join(' ');
}

function buildPrimaryCommand(
  model: MigrationModel,
  item: MigrationTreeItem,
): vscode.Command {
  if (canOpenRpcDiff(model)) {
    return {
      command: 'supabaseMigrationsBrowser.openMigration',
      title: 'Diff Latest RPC Version',
      arguments: [item],
    };
  }

  return {
    command: 'supabaseMigrationsBrowser.openSourceMigration',
    title: 'Open Latest Migration File',
    arguments: [item],
  };
}

async function getBaseMigrationFiles(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<MigrationFileDescriptor[]> {
  const mergeBase = await resolveMergeBase(workspaceFolder);

  if (!mergeBase) {
    return [];
  }

  const migrationPaths = await getMigrationPathsAtRef(workspaceFolder, mergeBase);
  const migrationFiles: Array<MigrationFileDescriptor | null> = await Promise.all(
    migrationPaths.map(async (migrationPath) => {
      const content = await getFileContentAtRef(
        workspaceFolder,
        mergeBase,
        migrationPath,
      );

      if (content === null) {
        return null;
      }

      return {
        content,
        fileName: path.posix.basename(migrationPath),
        sourceKind: 'history',
        uriString: vscode.Uri.joinPath(workspaceFolder.uri, migrationPath).toString(),
        workspaceRelativePath: migrationPath,
        workspaceFolderName: workspaceFolder.name,
      } satisfies MigrationFileDescriptor;
    }),
  );

  return migrationFiles.filter(
    (migrationFile): migrationFile is MigrationFileDescriptor => migrationFile !== null,
  );
}

async function resolveMergeBase(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string | null> {
  const comparisonRefs = await getComparisonRefs(workspaceFolder);

  for (const comparisonRef of comparisonRefs) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['merge-base', 'HEAD', comparisonRef],
        {
          cwd: workspaceFolder.uri.fsPath,
        },
      );

      const mergeBase = stdout.trim();

      if (mergeBase) {
        return mergeBase;
      }
    } catch {
      continue;
    }
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceFolder.uri.fsPath,
    });

    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getComparisonRefs(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string[]> {
  const refs = new Set<string>();

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      {
        cwd: workspaceFolder.uri.fsPath,
      },
    );

    const remoteHead = stdout.trim();

    if (remoteHead) {
      refs.add(remoteHead);
    }
  } catch {
    // Ignore missing remote HEAD metadata.
  }

  for (const candidateRef of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--verify', '--quiet', candidateRef],
        {
          cwd: workspaceFolder.uri.fsPath,
        },
      );

      if (stdout.trim()) {
        refs.add(candidateRef);
      }
    } catch {
      continue;
    }
  }

  return [...refs];
}

async function getMigrationPathsAtRef(
  workspaceFolder: vscode.WorkspaceFolder,
  ref: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-tree', '-r', '--name-only', ref, '--', 'supabase/migrations'],
      {
        cwd: workspaceFolder.uri.fsPath,
      },
    );

    return parseGitPathList(stdout).filter((migrationPath) =>
      migrationPath.toLowerCase().endsWith('.sql'),
    );
  } catch {
    return [];
  }
}

async function getFileContentAtRef(
  workspaceFolder: vscode.WorkspaceFolder,
  ref: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${ref}:${relativePath}`],
      {
        cwd: workspaceFolder.uri.fsPath,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return stdout;
  } catch {
    return null;
  }
}