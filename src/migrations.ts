export type MigrationFileDescriptor = {
  fileName: string;
  content: string;
  uriString: string;
  workspaceRelativePath: string;
  workspaceFolderName?: string;
  sourceKind?: RpcSourceKind;
};

export type RpcChangeState = 'new' | 'updated';
export type RpcSourceKind = 'workspace' | 'history';

export type MigrationModel = {
  id: string;
  fileName: string;
  label: string;
  description: string;
  changeState: RpcChangeState | null;
  timestamp: string | null;
  uriString: string;
  workspaceRelativePath: string;
  workspaceFolderName?: string;
  latestVersion: RpcVersionModel;
  previousVersion: RpcVersionModel | null;
  comparisonVersion: RpcVersionModel | null;
};

export type RpcVersionModel = {
  fileName: string;
  fileContent: string;
  qualifiedName: string;
  sqlDefinition: string;
  startLine: number;
  sourceKind: RpcSourceKind;
  timestamp: string | null;
  uriString: string;
  workspaceRelativePath: string;
  workspaceFolderName?: string;
};

export type EmptyStateModel = {
  label: string;
  message: string;
};

type SqlStatement = {
  sql: string;
  startLine: number;
  type: 'create-function' | 'other';
};

const TIMESTAMPED_MIGRATION_PATTERN =
  /^(?<timestamp>\d{14})[_-](?<slug>.+)\.sql$/i;
const CREATE_FUNCTION_PATTERN =
  /create\s+(?:or\s+replace\s+)?function\s+(?<qualifiedName>(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)\s*\(/gim;

type MigrationTimestamp = {
  fileName: string;
  timestamp: string | null;
};

type RpcEntry = {
  fileName: string;
  fileContent: string;
  qualifiedName: string;
  sqlDefinition: string;
  startLine: number;
  sourceKind: RpcSourceKind;
  timestamp: string | null;
  uriString: string;
  workspaceRelativePath: string;
  workspaceFolderName?: string;
};

export function parseMigrationFileName(
  fileName: string,
): MigrationTimestamp {
  const timestampedMatch = fileName.match(TIMESTAMPED_MIGRATION_PATTERN);

  if (timestampedMatch?.groups) {
    return {
      fileName,
      timestamp: timestampedMatch.groups.timestamp,
    };
  }

  return {
    fileName,
    timestamp: null,
  };
}

export function buildMigrationModels(
  files: MigrationFileDescriptor[],
  baseFiles: MigrationFileDescriptor[] = [],
): MigrationModel[] {
  const rpcEntries = files.flatMap(extractRpcEntries);
  const rpcVersionsByName = new Map<string, RpcEntry[]>();
  const baselineVersionsByName = buildLatestRpcVersionIndex(baseFiles);

  for (const rpcEntry of rpcEntries.sort(compareRpcEntriesNewestFirst)) {
    const normalizedKey = normalizeFunctionName(rpcEntry.qualifiedName);
    const existingEntries = rpcVersionsByName.get(normalizedKey) ?? [];

    existingEntries.push(rpcEntry);
    rpcVersionsByName.set(normalizedKey, existingEntries);
  }

  return [...rpcVersionsByName.values()]
    .map((rpcEntriesForName) => {
      const latestVersion = toRpcVersionModel(rpcEntriesForName[0]);
      const normalizedKey = normalizeFunctionName(latestVersion.qualifiedName);
      const baselineVersion = baselineVersionsByName.get(normalizedKey) ?? null;
      const previousVersion = rpcEntriesForName[1]
        ? toRpcVersionModel(rpcEntriesForName[1])
        : null;
      const comparisonVersion = previousVersion ?? baselineVersion;
      const changeState = getRpcChangeState(
        latestVersion,
        baselineVersion,
      );

      return {
        id: `${latestVersion.uriString}#${normalizeFunctionName(latestVersion.qualifiedName)}`,
        fileName: latestVersion.fileName,
        label: latestVersion.qualifiedName,
        description: latestVersion.timestamp
          ? formatTimestamp(latestVersion.timestamp)
          : latestVersion.fileName,
        changeState,
        timestamp: latestVersion.timestamp,
        uriString: latestVersion.uriString,
        workspaceRelativePath: latestVersion.workspaceRelativePath,
        workspaceFolderName: latestVersion.workspaceFolderName,
        latestVersion,
        previousVersion,
        comparisonVersion,
      };
    })
    .sort(compareMigrationsForView);
}

export function hasComparisonMigration(
  model: Pick<MigrationModel, 'comparisonVersion'>,
): boolean {
  return model.comparisonVersion !== null;
}

export function canOpenRpcDiff(
  model: Pick<MigrationModel, 'changeState' | 'latestVersion' | 'comparisonVersion'>,
): boolean {
  if (model.changeState === 'new' || !model.comparisonVersion) {
    return false;
  }

  return normalizeSqlForDiff(model.latestVersion.sqlDefinition) !==
    normalizeSqlForDiff(model.comparisonVersion.sqlDefinition);
}

export function filterMigrationModels(
  models: MigrationModel[],
  query: string,
): MigrationModel[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return models;
  }

  return models.filter((model) => {
    const haystack = [
      model.label,
      model.fileName,
      model.workspaceRelativePath,
      model.latestVersion.sqlDefinition,
      getLatestMigrationRelatedQueriesContent(model.latestVersion),
      model.previousVersion?.sqlDefinition ?? '',
    ]
      .join('\n')
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

export function hasLatestMigrationRelatedQueries(
  version: Pick<RpcVersionModel, 'fileContent' | 'sqlDefinition'>,
): boolean {
  return extractRelatedStatements(version).length > 0;
}

export function getLatestMigrationRelatedQueriesContent(
  version: Pick<
    RpcVersionModel,
    'fileContent' | 'fileName' | 'qualifiedName' | 'sqlDefinition' | 'workspaceRelativePath'
  >,
): string {
  const relatedStatements = extractRelatedStatements(version);

  if (relatedStatements.length === 0) {
    return [
      `-- RPC: ${version.qualifiedName}`,
      `-- Migration: ${version.fileName}`,
      `-- Source: ${version.workspaceRelativePath}`,
      '-- No related queries were found in the latest migration.',
      '',
    ].join('\n');
  }

  const headerLines = [
    `-- RPC: ${version.qualifiedName}`,
    `-- Migration: ${version.fileName}`,
    `-- Source: ${version.workspaceRelativePath}`,
    '-- Related queries from the latest migration (excluding function definitions)',
    '',
  ];

  return `${headerLines.join('\n')}${relatedStatements
    .map((statement) => normalizeSqlForDiff(statement.sql))
    .join('\n\n')}\n`;
}

export function getSearchEmptyState(query: string): EmptyStateModel {
  return {
    label: 'No RPC functions match the search',
    message: `No Supabase RPC functions matched "${query}".`,
  };
}

export function normalizeSqlForDiff(sqlDefinition: string): string {
  const normalizedEndOfLines = sqlDefinition.replace(/\r\n?/g, '\n');
  const trimmedLines = normalizedEndOfLines
    .split('\n')
    .map((line) => line.trimEnd());
  const nonEmptyLines = trimmedLines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length === 0) {
    return '';
  }

  const minimumIndentation = Math.min(
    ...nonEmptyLines.map((line) => line.match(/^\s*/)?.[0].length ?? 0),
  );

  return trimmedLines
    .map((line) => line.slice(Math.min(minimumIndentation, line.length)))
    .join('\n')
    .trim();
}

export function getEmptyState(props: {
  hasMigrationsFolder: boolean;
  hasSqlFiles: boolean;
}): EmptyStateModel | null {
  if (props.hasSqlFiles) {
    return null;
  }

  if (!props.hasMigrationsFolder) {
    return {
      label: 'No supabase/migrations folder found',
      message:
        'Open a workspace that contains supabase/migrations to browse Supabase RPC functions here.',
    };
  }

  return {
    label: 'No RPC functions found',
    message:
      'The workspace contains supabase/migrations, but no SQL migration currently defines a Supabase RPC function.',
  };
}

export function extractRpcNames(content: string): string[] {
  const sqlWithoutComments = stripSqlComments(content);
  const matches = sqlWithoutComments.matchAll(CREATE_FUNCTION_PATTERN);
  const names = new Set<string>();

  for (const match of matches) {
    const qualifiedName = normalizeFunctionName(match.groups?.qualifiedName);

    if (qualifiedName) {
      names.add(qualifiedName);
    }
  }

  return [...names];
}

function compareMigrationsForView(
  left: MigrationModel,
  right: MigrationModel,
): number {
  const changeStateComparison =
    getChangeStateSortWeight(left.changeState) -
    getChangeStateSortWeight(right.changeState);

  if (changeStateComparison !== 0) {
    return changeStateComparison;
  }

  const labelComparison = left.label.localeCompare(right.label, undefined, {
    sensitivity: 'base',
  });

  if (labelComparison !== 0) {
    return labelComparison;
  }

  if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) {
    return right.timestamp.localeCompare(left.timestamp);
  }

  return left.fileName.localeCompare(right.fileName, undefined, {
    sensitivity: 'base',
  });
}

function compareRpcEntriesNewestFirst(left: RpcEntry, right: RpcEntry): number {
  if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) {
    return right.timestamp.localeCompare(left.timestamp);
  }

  if (left.timestamp && !right.timestamp) {
    return -1;
  }

  if (!left.timestamp && right.timestamp) {
    return 1;
  }

  if (left.fileName !== right.fileName) {
    return right.fileName.localeCompare(left.fileName);
  }

  return left.qualifiedName.localeCompare(right.qualifiedName);
}

function buildLatestRpcVersionIndex(
  files: MigrationFileDescriptor[],
): Map<string, RpcVersionModel> {
  const latestVersionsByName = new Map<string, RpcVersionModel>();

  for (const rpcEntry of files.flatMap(extractRpcEntries).sort(compareRpcEntriesNewestFirst)) {
    const normalizedKey = normalizeFunctionName(rpcEntry.qualifiedName);

    if (!latestVersionsByName.has(normalizedKey)) {
      latestVersionsByName.set(normalizedKey, toRpcVersionModel(rpcEntry));
    }
  }

  return latestVersionsByName;
}

function extractRpcEntries(file: MigrationFileDescriptor): RpcEntry[] {
  const maskedContent = maskSqlComments(file.content);
  const parsedFileName = parseMigrationFileName(file.fileName);
  const matches = maskedContent.matchAll(CREATE_FUNCTION_PATTERN);
  const entries: RpcEntry[] = [];
  let consumedUntil = 0;

  for (const match of matches) {
    if (match.index === undefined || match.index < consumedUntil) {
      continue;
    }

    const qualifiedName = normalizeFunctionName(match.groups?.qualifiedName);

    if (!qualifiedName) {
      continue;
    }

    const statementEnd = findSqlStatementEnd(maskedContent, match.index);
    const sqlDefinition = file.content.slice(match.index, statementEnd).trim();

    consumedUntil = statementEnd;

    entries.push({
      fileContent: file.content,
      fileName: file.fileName,
      qualifiedName,
      sqlDefinition,
      startLine: getLineNumberAtOffset(file.content, match.index),
      sourceKind: file.sourceKind ?? 'workspace',
      timestamp: parsedFileName.timestamp,
      uriString: file.uriString,
      workspaceRelativePath: file.workspaceRelativePath,
      workspaceFolderName: file.workspaceFolderName,
    });
  }

  return entries;
}

function extractRelatedStatements(
  version: Pick<RpcVersionModel, 'fileContent' | 'sqlDefinition'>,
): SqlStatement[] {
  const normalizedDefinition = normalizeSqlForDiff(version.sqlDefinition);

  return extractSqlStatements(version.fileContent).filter((statement) => {
    if (statement.type === 'create-function') {
      return false;
    }

    return normalizeSqlForDiff(statement.sql) !== normalizedDefinition;
  });
}

function extractSqlStatements(content: string): SqlStatement[] {
  const maskedContent = maskSqlComments(content);
  const statements: SqlStatement[] = [];
  let index = 0;

  while (index < maskedContent.length) {
    while (index < maskedContent.length && /\s/.test(maskedContent[index] ?? '')) {
      index += 1;
    }

    if (index >= maskedContent.length) {
      break;
    }

    const statementStart = index;
    const statementEnd = findSqlStatementEnd(maskedContent, statementStart);
    const sql = content.slice(statementStart, statementEnd).trim();

    index = statementEnd;

    if (!sql) {
      continue;
    }

    statements.push({
      sql,
      startLine: getLineNumberAtOffset(content, statementStart),
      type: /^create\s+(?:or\s+replace\s+)?function\b/i.test(sql)
        ? 'create-function'
        : 'other',
    });
  }

  return statements;
}

function toRpcVersionModel(rpcEntry: RpcEntry): RpcVersionModel {
  return {
    fileName: rpcEntry.fileName,
    fileContent: rpcEntry.fileContent,
    qualifiedName: rpcEntry.qualifiedName,
    sqlDefinition: rpcEntry.sqlDefinition,
    startLine: rpcEntry.startLine,
    sourceKind: rpcEntry.sourceKind,
    timestamp: rpcEntry.timestamp,
    uriString: rpcEntry.uriString,
    workspaceRelativePath: rpcEntry.workspaceRelativePath,
    workspaceFolderName: rpcEntry.workspaceFolderName,
  };
}

function getRpcChangeState(
  latestVersion: RpcVersionModel,
  baselineVersion: RpcVersionModel | null,
): RpcChangeState | null {
  if (!baselineVersion) {
    return 'new';
  }

  return normalizeSqlForDiff(latestVersion.sqlDefinition) ===
    normalizeSqlForDiff(baselineVersion.sqlDefinition)
    ? null
    : 'updated';
}

function getChangeStateSortWeight(changeState: RpcChangeState | null): number {
  if (changeState === 'new') {
    return 0;
  }

  if (changeState === 'updated') {
    return 1;
  }

  return 2;
}

function normalizeFunctionName(value?: string): string {
  if (!value) {
    return '';
  }

  return value.replace(/\s*\.\s*/g, '.').trim();
}

function stripSqlComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*--.*$/gm, ' ');
}

function maskSqlComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => maskSqlFragment(match))
    .replace(/^\s*--.*$/gm, (match) => maskSqlFragment(match));
}

function maskSqlFragment(fragment: string): string {
  return fragment.replace(/[^\r\n]/g, ' ');
}

function findSqlStatementEnd(content: string, startIndex: number): number {
  let index = startIndex;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarQuoteTag: string | null = null;

  while (index < content.length) {
    if (dollarQuoteTag) {
      if (content.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length;
        dollarQuoteTag = null;
        continue;
      }

      index += 1;
      continue;
    }

    const currentCharacter = content[index];
    const nextCharacter = content[index + 1];

    if (inSingleQuote) {
      if (currentCharacter === '\'' && nextCharacter === '\'') {
        index += 2;
        continue;
      }

      if (currentCharacter === '\'') {
        inSingleQuote = false;
      }

      index += 1;
      continue;
    }

    if (inDoubleQuote) {
      if (currentCharacter === '"' && nextCharacter === '"') {
        index += 2;
        continue;
      }

      if (currentCharacter === '"') {
        inDoubleQuote = false;
      }

      index += 1;
      continue;
    }

    if (currentCharacter === '\'') {
      inSingleQuote = true;
      index += 1;
      continue;
    }

    if (currentCharacter === '"') {
      inDoubleQuote = true;
      index += 1;
      continue;
    }

    if (currentCharacter === '$') {
      const dollarQuoteMatch = content.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);

      if (dollarQuoteMatch) {
        dollarQuoteTag = dollarQuoteMatch[0];
        index += dollarQuoteTag.length;
        continue;
      }
    }

    if (currentCharacter === ';') {
      return index + 1;
    }

    index += 1;
  }

  return content.length;
}

function formatTimestamp(timestamp: string): string {
  if (!/^\d{14}$/.test(timestamp)) {
    return timestamp;
  }

  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} ${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}`;
}

function getLineNumberAtOffset(content: string, offset: number): number {
  let lineNumber = 0;

  for (let index = 0; index < offset; index += 1) {
    if (content[index] === '\n') {
      lineNumber += 1;
    }
  }

  return lineNumber;
}