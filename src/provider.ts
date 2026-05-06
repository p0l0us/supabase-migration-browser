import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { parseGitPathList } from './git-status';
import {
  buildMigrationModels,
  filterMigrationModels,
  getEmptyState,
  getFilteredSearchEmptyState,
  type EmptyStateModel,
  type MigrationKindFilter,
  type MigrationFileDescriptor,
  type MigrationModel,
} from './migrations';

const execFileAsync = promisify(execFile);
export type ProviderState = {
  emptyState: EmptyStateModel | null;
  includeWorkspaceName: boolean;
  items: MigrationModel[];
};

export class SupabaseMigrationsProvider
  implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<ProviderState>();
  private readonly watcher: vscode.FileSystemWatcher;
  private cachedState?: ProviderState;
  private kindFilter: MigrationKindFilter = 'all';
  private searchQuery = '';
  private stateRequestId = 0;

  readonly onDidChangeState = this.stateEmitter.event;

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
    this.stateEmitter.dispose();
  }

  async refresh(): Promise<void> {
    await this.loadState(true, true);
  }

  async setSearchQuery(searchQuery: string): Promise<void> {
    this.searchQuery = searchQuery;
    await this.loadState(true, true);
  }

  async setKindFilter(kindFilter: MigrationKindFilter): Promise<void> {
    this.kindFilter = kindFilter;
    await this.loadState(true, true);
  }

  getKindFilter(): MigrationKindFilter {
    return this.kindFilter;
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  async getState(force = false): Promise<ProviderState> {
    return this.loadState(force, false);
  }

  private async loadState(force: boolean, emit: boolean): Promise<ProviderState> {
    if (!force && this.cachedState) {
      return this.cachedState;
    }

    const requestId = ++this.stateRequestId;
    const state = await this.readState();

    if (requestId !== this.stateRequestId) {
      return this.cachedState ?? state;
    }

    this.cachedState = state;

    if (emit) {
      this.stateEmitter.fire(state);
    }

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
    const filteredItems = filterMigrationModels(items, this.searchQuery, this.kindFilter);

    const emptyState = this.searchQuery.trim()
      ? filteredItems.length === 0
        ? getFilteredSearchEmptyState(this.searchQuery.trim(), this.kindFilter)
        : null
      : getEmptyState({
        hasMigrationsFolder,
        hasSqlFiles: items.length > 0,
        hasFilteredItems: filteredItems.length > 0,
        kindFilter: this.kindFilter,
      });

    return {
      emptyState,
      includeWorkspaceName: workspaceFolders.length > 1,
      items: filteredItems,
    };
  }
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