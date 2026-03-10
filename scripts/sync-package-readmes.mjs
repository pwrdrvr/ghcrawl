import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const rootReadmePath = path.join(repoRoot, 'README.md');
const cliReadmePath = path.join(repoRoot, 'apps', 'cli', 'README.md');

const githubBlobBase = 'https://github.com/pwrdrvr/ghcrawl/blob/main/';
const githubRawBase = 'https://raw.githubusercontent.com/pwrdrvr/ghcrawl/main/';

function normalizeRootReadme(markdown) {
  const lines = markdown.split('\n');
  if (lines[0]?.startsWith('# ')) {
    lines.unshift(
      '<!-- This file is generated from the repository root README.md. Edit README.md and rerun scripts/sync-package-readmes.mjs. -->',
      '',
    );
  }
  let text = lines.join('\n');

  text = text.replace(/!\[([^\]]*)\]\(\.\/([^)]+)\)/g, (_match, alt, relativePath) => {
    return `![${alt}](${githubRawBase}${relativePath})`;
  });

  text = text.replace(/\((\.\/[^)]+)\)/g, (_match, relativePathWithDot) => {
    return `(${githubBlobBase}${relativePathWithDot.slice(2)})`;
  });

  return text;
}

const rootReadme = readFileSync(rootReadmePath, 'utf8');
const cliReadme = normalizeRootReadme(rootReadme);
writeFileSync(cliReadmePath, cliReadme);
