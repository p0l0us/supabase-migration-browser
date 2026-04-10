export function parseGitStatusPaths(stdout: string): Set<string> {
  const paths = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const rawPath = line.slice(3).trim();

    if (!rawPath) {
      continue;
    }

    const normalizedPath = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').at(-1)?.trim()
      : rawPath;

    if (normalizedPath) {
      paths.add(normalizedPath);
    }
  }

  return paths;
}

export function parseGitPathList(stdout: string): string[] {
  const paths: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const normalizedPath = line.trim();

    if (normalizedPath) {
      paths.push(normalizedPath);
    }
  }

  return paths;
}