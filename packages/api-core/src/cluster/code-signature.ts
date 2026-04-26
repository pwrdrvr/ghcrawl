import crypto from 'node:crypto';

const TOKEN_RE = /[a-zA-Z0-9_.$/-]+/g;
const MAX_PATCH_CHARS_FOR_HUNKS = 120_000;
const MAX_PATCH_CHARS_PER_FILE = 20_000;
const MAX_FILES_FOR_HUNK_EXTRACTION = 100;
const GENERATED_OR_SETUP_PATH_RE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|npm-shrinkwrap\.json|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum|dist|build|coverage|vendor|generated)(\/|$)/i;

export type PullFileMetadata = {
  filename: string;
  status?: string | null;
  previousFilename?: string | null;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | null;
  sha?: string | null;
};

export type HunkSignature = {
  path: string;
  hunkHash: string;
  contextHash: string;
  addedTokenHash: string;
  removedTokenHash: string;
};

export type CodeSnapshotSignature = {
  files: PullFileMetadata[];
  patchDigest: string;
  hunkSignatures: HunkSignature[];
};

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function tokenize(value: string): string[] {
  return Array.from(value.toLowerCase().matchAll(TOKEN_RE)).map((match) => match[0]);
}

function tokenHash(lines: string[]): string {
  return sha256(JSON.stringify(lines.flatMap(tokenize).sort()));
}

export function normalizePullFile(payload: Record<string, unknown>): PullFileMetadata {
  return {
    filename: String(payload.filename ?? ''),
    status: typeof payload.status === 'string' ? payload.status : null,
    previousFilename: typeof payload.previous_filename === 'string' ? payload.previous_filename : null,
    additions: Number(payload.additions ?? 0),
    deletions: Number(payload.deletions ?? 0),
    changes: Number(payload.changes ?? 0),
    patch: typeof payload.patch === 'string' ? payload.patch : null,
    sha: typeof payload.sha === 'string' ? payload.sha : null,
  };
}

export function extractHunkSignatures(path: string, patch: string | null | undefined): HunkSignature[] {
  if (!patch) return [];

  const signatures: HunkSignature[] = [];
  let header: string | null = null;
  let context: string[] = [];
  let added: string[] = [];
  let removed: string[] = [];

  function flush(): void {
    if (!header) return;
    const hunkPayload = JSON.stringify({
      path,
      header,
      contextHash: tokenHash(context),
      addedTokenHash: tokenHash(added),
      removedTokenHash: tokenHash(removed),
    });
    signatures.push({
      path,
      hunkHash: sha256(hunkPayload),
      contextHash: tokenHash(context),
      addedTokenHash: tokenHash(added),
      removedTokenHash: tokenHash(removed),
    });
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      header = line;
      context = [];
      added = [];
      removed = [];
      continue;
    }
    if (!header || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      added.push(line.slice(1));
    } else if (line.startsWith('-')) {
      removed.push(line.slice(1));
    } else {
      context.push(line.startsWith(' ') ? line.slice(1) : line);
    }
  }
  flush();

  return signatures;
}

export function buildCodeSnapshotSignature(files: Array<Record<string, unknown>>): CodeSnapshotSignature {
  const normalizedFiles = files.map(normalizePullFile).filter((file) => file.filename.length > 0);
  const totalPatchChars = normalizedFiles.reduce((total, file) => total + (file.patch?.length ?? 0), 0);
  const shouldExtractHunks =
    normalizedFiles.length <= MAX_FILES_FOR_HUNK_EXTRACTION && totalPatchChars <= MAX_PATCH_CHARS_FOR_HUNKS;
  const hunkSignatures = shouldExtractHunks
    ? normalizedFiles.flatMap((file) => {
        if (isPatchTooBroadForHunks(file)) {
          return [];
        }
        return extractHunkSignatures(file.filename, file.patch);
      })
    : [];
  const patchDigest = sha256(
    JSON.stringify(
      normalizedFiles.map((file) => ({
        filename: file.filename,
        status: file.status,
        previousFilename: file.previousFilename,
        additions: file.additions,
        deletions: file.deletions,
        patchHash: shouldHashPatch(file) ? sha256(file.patch ?? '') : null,
      })),
    ),
  );

  return {
    files: normalizedFiles,
    patchDigest,
    hunkSignatures,
  };
}

function isPatchTooBroadForHunks(file: PullFileMetadata): boolean {
  return (
    !file.patch ||
    file.patch.length > MAX_PATCH_CHARS_PER_FILE ||
    file.changes > 2_000 ||
    GENERATED_OR_SETUP_PATH_RE.test(file.filename)
  );
}

function shouldHashPatch(file: PullFileMetadata): boolean {
  return Boolean(file.patch) && file.patch!.length <= MAX_PATCH_CHARS_PER_FILE && !GENERATED_OR_SETUP_PATH_RE.test(file.filename);
}
