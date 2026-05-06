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
export type MigrationObjectKind = 'rpc' | 'view';
export type MigrationKindFilter = 'all' | 'rpcs' | 'views';

export type MigrationModel = {
  id: string;
  fileName: string;
  kind: MigrationObjectKind;
  label: string;
  description: string;
  changeState: RpcChangeState | null;
  timestamp: string | null;
  uriString: string;
  workspaceRelativePath: string;
  workspaceFolderName?: string;
  allVersions: RpcVersionModel[];
  latestVersion: RpcVersionModel;
  previousVersion: RpcVersionModel | null;
  comparisonVersion: RpcVersionModel | null;
};

export type RpcVersionModel = {
  fileName: string;
  fileContent: string;
  kind: MigrationObjectKind;
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
  type: 'object-definition' | 'other';
};

const TIMESTAMPED_MIGRATION_PATTERN =
  /^(?<timestamp>\d{14})[_-](?<slug>.+)\.sql$/i;
const QUALIFIED_SQL_IDENTIFIER_PATTERN =
  '(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\\s*\\.\\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?';
const CREATE_FUNCTION_PATTERN =
  /create\s+(?:or\s+replace\s+)?function\s+(?<qualifiedName>(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)\s*\(/gim;
const CREATE_VIEW_PATTERN = new RegExp(
  `create\\s+(?:or\\s+replace\\s+)?(?:(?:temporary|temp)\\s+)?(?:materialized\\s+)?(?:recursive\\s+)?view\\s+(?<qualifiedName>${QUALIFIED_SQL_IDENTIFIER_PATTERN})(?:\\s*\\([^;]*?\\))?\\s+as\\b`,
  'gim',
);
const CREATE_OBJECT_PATTERN = new RegExp(
  `^create\\s+(?:or\\s+replace\\s+)?(?:(?:temporary|temp)\\s+)?(?:(?:materialized|recursive)\\s+)?(?:function|view)\\b`,
  'i',
);

type MigrationTimestamp = {
  fileName: string;
  timestamp: string | null;
};

type RpcEntry = {
  fileName: string;
  fileContent: string;
  kind: MigrationObjectKind;
  qualifiedName: string;
  sqlDefinition: string;
  startLine: number;
  sourceKind: RpcSourceKind;
  timestamp: string | null;
  uriString: string;
  workspaceRelativePath: string;
  workspaceFolderName?: string;
};

type BuildMigrationModelsOptions = {
  detectChanges?: boolean;
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
  options: BuildMigrationModelsOptions = {},
): MigrationModel[] {
  const detectChanges = options.detectChanges ?? true;
  const objectEntries = files.flatMap(extractObjectEntries);
  const objectVersionsByName = new Map<string, RpcEntry[]>();
  const baselineVersionsByName = detectChanges
    ? buildLatestObjectVersionIndex(baseFiles)
    : new Map<string, RpcVersionModel>();

  for (const objectEntry of objectEntries.sort(compareRpcEntriesNewestFirst)) {
    const normalizedKey = getObjectKey(objectEntry.kind, objectEntry.qualifiedName);
    const existingEntries = objectVersionsByName.get(normalizedKey) ?? [];

    existingEntries.push(objectEntry);
    objectVersionsByName.set(normalizedKey, existingEntries);
  }

  return [...objectVersionsByName.values()]
    .map((objectEntriesForName) => {
      const allVersions = objectEntriesForName.map(toRpcVersionModel);
      const latestVersion = toRpcVersionModel(objectEntriesForName[0]);
      const normalizedKey = getObjectKey(latestVersion.kind, latestVersion.qualifiedName);
      const baselineVersion = detectChanges
        ? baselineVersionsByName.get(normalizedKey) ?? null
        : null;
      const previousVersion = objectEntriesForName[1]
        ? toRpcVersionModel(objectEntriesForName[1])
        : null;
      const comparisonVersion = detectChanges
        ? baselineVersion ?? previousVersion
        : previousVersion;
      const changeState = detectChanges
        ? getRpcChangeState(latestVersion, baselineVersion)
        : null;

      return {
        id: `${latestVersion.uriString}#${latestVersion.kind}:${normalizeFunctionName(latestVersion.qualifiedName)}`,
        fileName: latestVersion.fileName,
        kind: latestVersion.kind,
        label: latestVersion.qualifiedName,
        description: latestVersion.timestamp
          ? formatTimestamp(latestVersion.timestamp)
          : latestVersion.fileName,
        changeState,
        timestamp: latestVersion.timestamp,
        uriString: latestVersion.uriString,
        workspaceRelativePath: latestVersion.workspaceRelativePath,
        workspaceFolderName: latestVersion.workspaceFolderName,
        allVersions,
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
  kindFilter: MigrationKindFilter = 'all',
  showOnlyChanged = false,
): MigrationModel[] {
  const normalizedQuery = query.trim().toLowerCase();
  const selectedKind = getObjectKindForFilter(kindFilter);
  const kindFilteredModels = kindFilter === 'all'
    ? models
    : models.filter((model) => model.kind === selectedKind);
  const changeFilteredModels = showOnlyChanged
    ? kindFilteredModels.filter((model) => model.changeState !== null)
    : kindFilteredModels;

  if (!normalizedQuery) {
    return changeFilteredModels;
  }

  return changeFilteredModels.filter((model) => {
    const haystack = [
      model.kind,
      model.label,
      model.fileName,
      model.workspaceRelativePath,
      model.latestVersion.sqlDefinition,
      getMigrationRelatedQueriesContent(model),
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

export function hasMigrationRelatedQueriesContent(
  model: Pick<MigrationModel, 'allVersions'>,
): boolean {
  return model.allVersions.length > 0;
}

export function getMigrationRelatedQueriesContent(
  model: Pick<MigrationModel, 'allVersions' | 'kind' | 'label'>,
): string {
  const objectLabel = getObjectKindLabel(model.kind);
  const headerLines = [
    `-- Related queries for ${objectLabel}: ${model.label}`,
    '-- Workspace migration versions are listed newest first.',
    '-- Object definitions are replaced with version markers.',
    '',
  ];
  const migrationBlocks = model.allVersions.map(formatRelatedQueriesVersionBlock);

  return `${headerLines.join('\n')}${migrationBlocks.join('\n\n')}\n`;
}

export function getLatestMigrationRelatedQueriesContent(
  version: Pick<
    RpcVersionModel,
    'fileContent' | 'fileName' | 'kind' | 'qualifiedName' | 'sqlDefinition' | 'workspaceRelativePath'
  >,
): string {
  const relatedStatements = extractRelatedStatements(version);
  const objectLabel = getObjectKindLabel(version.kind);

  if (relatedStatements.length === 0) {
    return [
      `-- ${objectLabel}: ${version.qualifiedName}`,
      `-- Migration: ${version.fileName}`,
      `-- Source: ${version.workspaceRelativePath}`,
      '-- No related queries were found in the latest migration.',
      '',
    ].join('\n');
  }

  const headerLines = [
    `-- ${objectLabel}: ${version.qualifiedName}`,
    `-- Migration: ${version.fileName}`,
    `-- Source: ${version.workspaceRelativePath}`,
    '-- Related queries from the latest migration (excluding object definitions)',
    '',
  ];

  return `${headerLines.join('\n')}${relatedStatements
    .map((statement) => normalizeSqlForDiff(statement.sql))
    .join('\n\n')}\n`;
}

export function getSearchEmptyState(query: string): EmptyStateModel {
  return getFilteredSearchEmptyState(query, 'all', false);
}

export function getFilteredSearchEmptyState(
  query: string,
  kindFilter: MigrationKindFilter,
  showOnlyChanged = false,
): EmptyStateModel {
  const labelNoun = getFilterLabelNoun(kindFilter);
  const changedOnlyMessage = showOnlyChanged
    ? ' Clear Show only new or updated to include unchanged objects in the search.'
    : '';

  return {
    label: `No ${labelNoun} match the search`,
    message: `No Supabase ${labelNoun} matched "${query}".${changedOnlyMessage}`,
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
  hasFilteredItems?: boolean;
  kindFilter?: MigrationKindFilter;
  showOnlyChanged?: boolean;
}): EmptyStateModel | null {
  const kindFilter = props.kindFilter ?? 'all';
  const hasFilteredItems = props.hasFilteredItems ?? props.hasSqlFiles;

  if (hasFilteredItems) {
    return null;
  }

  if (!props.hasMigrationsFolder) {
    return {
      label: 'No supabase/migrations folder found',
      message:
        'Open a workspace that contains supabase/migrations to browse Supabase RPC functions here.',
    };
  }

  if (props.hasSqlFiles && props.showOnlyChanged) {
    const filterNoun = getFilterLabelNoun(kindFilter);

    return {
      label: `No new or updated ${filterNoun} found`,
      message: `No Supabase ${filterNoun} changed compared with the selected branch. Clear Show only new or updated to browse unchanged objects too.`,
    };
  }

  if (props.hasSqlFiles && kindFilter !== 'all') {
    const filterNoun = getFilterLabelNoun(kindFilter);

    return {
      label: `No Supabase ${filterNoun} found`,
      message: `No Supabase ${filterNoun} matched the current type filter. Choose All to show every discovered RPC and view.`,
    };
  }

  return {
    label: 'No Supabase RPCs or views found',
    message:
      'The workspace contains supabase/migrations, but no SQL migration currently defines a Supabase RPC function or view.',
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

export function extractViewNames(content: string): string[] {
  const sqlWithoutComments = stripSqlComments(content);
  const matches = sqlWithoutComments.matchAll(CREATE_VIEW_PATTERN);
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

  const nameComparison = left.qualifiedName.localeCompare(right.qualifiedName);

  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.kind.localeCompare(right.kind);
}

function buildLatestObjectVersionIndex(
  files: MigrationFileDescriptor[],
): Map<string, RpcVersionModel> {
  const latestVersionsByName = new Map<string, RpcVersionModel>();

  for (const objectEntry of files.flatMap(extractObjectEntries).sort(compareRpcEntriesNewestFirst)) {
    const normalizedKey = getObjectKey(objectEntry.kind, objectEntry.qualifiedName);

    if (!latestVersionsByName.has(normalizedKey)) {
      latestVersionsByName.set(normalizedKey, toRpcVersionModel(objectEntry));
    }
  }

  return latestVersionsByName;
}

function extractObjectEntries(file: MigrationFileDescriptor): RpcEntry[] {
  const maskedContent = maskSqlComments(file.content);
  const parsedFileName = parseMigrationFileName(file.fileName);
  const objectDefinitions = [
    ...findObjectDefinitions(maskedContent, CREATE_FUNCTION_PATTERN, 'rpc'),
    ...findObjectDefinitions(maskedContent, CREATE_VIEW_PATTERN, 'view'),
  ].sort((left, right) => left.index - right.index);
  const entries: RpcEntry[] = [];
  let consumedUntil = 0;

  for (const objectDefinition of objectDefinitions) {
    if (objectDefinition.index < consumedUntil) {
      continue;
    }

    const qualifiedName = normalizeFunctionName(objectDefinition.qualifiedName);

    if (!qualifiedName) {
      continue;
    }

    const statementEnd = findSqlStatementEnd(maskedContent, objectDefinition.index);
    const sqlDefinition = file.content.slice(objectDefinition.index, statementEnd).trim();

    consumedUntil = statementEnd;

    entries.push({
      fileContent: file.content,
      fileName: file.fileName,
      kind: objectDefinition.kind,
      qualifiedName,
      sqlDefinition,
      startLine: getLineNumberAtOffset(file.content, objectDefinition.index),
      sourceKind: file.sourceKind ?? 'workspace',
      timestamp: parsedFileName.timestamp,
      uriString: file.uriString,
      workspaceRelativePath: file.workspaceRelativePath,
      workspaceFolderName: file.workspaceFolderName,
    });
  }

  return entries;
}

function findObjectDefinitions(
  content: string,
  pattern: RegExp,
  kind: MigrationObjectKind,
): Array<{ index: number; kind: MigrationObjectKind; qualifiedName: string | undefined }> {
  return [...content.matchAll(pattern)].flatMap((match) => {
    if (match.index === undefined) {
      return [];
    }

    return [{
      index: match.index,
      kind,
      qualifiedName: match.groups?.qualifiedName,
    }];
  });
}

function extractRelatedStatements(
  version: Pick<RpcVersionModel, 'fileContent' | 'sqlDefinition'>,
): SqlStatement[] {
  const normalizedDefinition = normalizeSqlForDiff(version.sqlDefinition);

  return extractSqlStatements(version.fileContent).filter((statement) => {
    if (statement.type === 'object-definition') {
      return false;
    }

    return normalizeSqlForDiff(statement.sql) !== normalizedDefinition;
  });
}

function formatRelatedQueriesVersionBlock(version: RpcVersionModel): string {
  const statements = extractSqlStatements(version.fileContent);
  const markerLines = formatObjectVersionMarker(version);
  const contentLines: string[] = [
    `-- === BEGIN MIGRATION: ${version.fileName} ===`,
    `-- Source: ${version.workspaceRelativePath}`,
  ];
  let markerWasAdded = false;

  for (const statement of statements) {
    if (statement.type === 'object-definition') {
      if (isSelectedObjectDefinition(statement, version)) {
        appendSection(contentLines, markerLines);
        markerWasAdded = true;
      }

      continue;
    }

    appendSection(contentLines, [normalizeSqlForDiff(statement.sql)]);
  }

  if (!markerWasAdded) {
    appendSection(contentLines, markerLines);
  }

  contentLines.push(`-- === END MIGRATION: ${version.fileName} ===`);

  return contentLines.join('\n');
}

function formatObjectVersionMarker(version: RpcVersionModel): string[] {
  const objectLabel = getObjectKindLabel(version.kind);

  return [
    `-- === ${objectLabel} VERSION MARKER ===`,
    `-- ${objectLabel}: ${version.qualifiedName}`,
    `-- Migration: ${version.fileName}`,
    '-- Definition omitted from related queries.',
    `-- === END ${objectLabel} VERSION MARKER ===`,
  ];
}

function appendSection(lines: string[], sectionLines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    lines.push('');
  }

  lines.push(...sectionLines);
}

function isSelectedObjectDefinition(
  statement: SqlStatement,
  version: Pick<RpcVersionModel, 'sqlDefinition'>,
): boolean {
  return normalizeSqlForDiff(statement.sql) === normalizeSqlForDiff(version.sqlDefinition);
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
      type: CREATE_OBJECT_PATTERN.test(sql)
        ? 'object-definition'
        : 'other',
    });
  }

  return statements;
}

function toRpcVersionModel(rpcEntry: RpcEntry): RpcVersionModel {
  return {
    fileName: rpcEntry.fileName,
    fileContent: rpcEntry.fileContent,
    kind: rpcEntry.kind,
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

function getObjectKey(kind: MigrationObjectKind, qualifiedName: string): string {
  return `${kind}:${normalizeFunctionName(qualifiedName)}`;
}

function getObjectKindForFilter(kindFilter: MigrationKindFilter): MigrationObjectKind | null {
  if (kindFilter === 'rpcs') {
    return 'rpc';
  }

  if (kindFilter === 'views') {
    return 'view';
  }

  return null;
}

function getFilterLabelNoun(kindFilter: MigrationKindFilter): string {
  if (kindFilter === 'rpcs') {
    return 'RPC functions';
  }

  if (kindFilter === 'views') {
    return 'views';
  }

  return 'RPC functions or views';
}

function getObjectKindLabel(kind: MigrationObjectKind): string {
  return kind === 'view' ? 'View' : 'RPC';
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