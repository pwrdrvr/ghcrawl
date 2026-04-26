export type CommandName =
  | 'doctor'
  | 'configure'
  | 'version'
  | 'sync'
  | 'export-sync'
  | 'validate-sync'
  | 'portable-size'
  | 'sync-status'
  | 'import-sync'
  | 'refresh'
  | 'optimize'
  | 'runs'
  | 'threads'
  | 'close-thread'
  | 'close-cluster'
  | 'exclude-cluster-member'
  | 'include-cluster-member'
  | 'set-cluster-canonical'
  | 'merge-clusters'
  | 'split-cluster'
  | 'summarize'
  | 'key-summaries'
  | 'purge-comments'
  | 'embed'
  | 'cluster'
  | 'cluster-experiment'
  | 'clusters'
  | 'durable-clusters'
  | 'cluster-detail'
  | 'cluster-explain'
  | 'search'
  | 'neighbors'
  | 'tui'
  | 'serve';

export type CommandSpec = {
  name: CommandName;
  synopsis: string;
  description: string;
  options: string[];
  examples: string[];
  devOnly?: boolean;
  agentJson?: boolean;
};

const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: 'doctor',
    synopsis: 'doctor [--json]',
    description: 'Check local config, database wiring, and auth health.',
    options: ['--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl doctor', 'ghcrawl doctor --json'],
    agentJson: true,
  },
  {
    name: 'configure',
    synopsis: 'configure [--summary-model gpt-5.4|gpt-5-mini|gpt-5.4-mini] [--embedding-basis title_original|title_summary|llm_key_summary] [--json]',
    description: 'Show or update persisted summarization and embedding settings.',
    options: [
      '--summary-model <model>  Select gpt-5.4, gpt-5-mini, or gpt-5.4-mini for summarization',
      '--embedding-basis <basis>  Select title_original, title_summary, or llm_key_summary for active vectors',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl configure', 'ghcrawl configure --summary-model gpt-5.4', 'ghcrawl configure --embedding-basis title_original --json'],
    agentJson: true,
  },
  {
    name: 'version',
    synopsis: 'version',
    description: 'Print the installed ghcrawl version.',
    options: [],
    examples: ['ghcrawl version', 'ghcrawl --version'],
  },
  {
    name: 'sync',
    synopsis: 'sync <owner/repo> [--since <iso|duration>] [--limit <count>] [--include-comments] [--include-code] [--full-reconcile] [--json]',
    description: 'Sync open GitHub issues and PRs into the local database.',
    options: [
      '--since <iso|duration>  Limit sync window using ISO time or 15m/2h/7d/1mo',
      '--limit <count>  Limit the number of synced items',
      '--include-comments  Hydrate issue comments, PR reviews, and review comments',
      '--include-code  Hydrate pull request file metadata and patch signatures',
      '--full-reconcile  Reconcile stale open items instead of metadata-only incrementals',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl sync openclaw/openclaw --limit 1', 'ghcrawl sync openclaw/openclaw --since 7d --json'],
    agentJson: true,
  },
  {
    name: 'export-sync',
    synopsis: 'export-sync <owner/repo> [--output <path>] [--profile lean|review] [--manifest] [--body-chars <count>] [--json]',
    description: 'Export a compact portable SQLite core for git-style file sync.',
    options: [
      '--output <path>  Output SQLite path; defaults to the ghcrawl config exports directory',
      '--profile lean|review  Use a preset body excerpt budget for git sync',
      '--manifest  Write a JSON sidecar with counts, SHA256, and validation status',
      '--body-chars <count>  Maximum body excerpt characters per thread; default 512',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl export-sync openclaw/openclaw --profile lean --manifest --output ./openclaw.sync.db --json'],
    agentJson: true,
  },
  {
    name: 'validate-sync',
    synopsis: 'validate-sync <path> [--json]',
    description: 'Validate a portable git-sync SQLite database without mutating it.',
    options: ['--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl validate-sync ./openclaw.sync.db --json'],
    agentJson: true,
  },
  {
    name: 'portable-size',
    synopsis: 'portable-size <path> [--json]',
    description: 'Report portable git-sync SQLite table sizes.',
    options: ['--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl portable-size ./openclaw.sync.db --json'],
    agentJson: true,
  },
  {
    name: 'sync-status',
    synopsis: 'sync-status <owner/repo> --portable <path> [--json]',
    description: 'Compare the live repository store against a portable git-sync SQLite database.',
    options: ['--portable <path>  Portable SQLite path to compare', '--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl sync-status openclaw/openclaw --portable ./openclaw.sync.db --json'],
    agentJson: true,
  },
  {
    name: 'import-sync',
    synopsis: 'import-sync <path> [--json]',
    description: 'Import a portable git-sync SQLite database into the configured live store.',
    options: ['--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl import-sync ./openclaw.sync.db --json'],
    agentJson: true,
  },
  {
    name: 'refresh',
    synopsis: 'refresh <owner/repo> [--include-code] [--no-sync] [--no-embed] [--no-cluster] [--heap-snapshot-dir <dir>] [--heap-log-interval-ms <ms>] [--json]',
    description: 'Run sync, embed, and cluster in one staged pipeline.',
    options: [
      '--no-sync  Skip the GitHub sync stage',
      '--include-code  Hydrate pull request file metadata during sync',
      '--no-embed  Skip the embeddings stage',
      '--no-cluster  Skip the clustering stage',
      '--heap-snapshot-dir <dir>  Write heap snapshots during long-running work',
      '--heap-log-interval-ms <ms>  Emit periodic heap diagnostics',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl refresh openclaw/openclaw', 'ghcrawl refresh openclaw/openclaw --no-sync --json'],
    agentJson: true,
  },
  {
    name: 'optimize',
    synopsis: 'optimize [owner/repo] [--json]',
    description: 'Checkpoint, analyze, optimize, and vacuum local SQLite stores.',
    options: [
      'owner/repo  Also optimize this repository vector store when present',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl optimize --json', 'ghcrawl optimize openclaw/openclaw --json'],
    agentJson: true,
  },
  {
    name: 'runs',
    synopsis: 'runs <owner/repo> [--kind sync|summary|embedding|cluster] [--limit <count>] [--json]',
    description: 'List recent local pipeline runs and failures for one repo.',
    options: [
      '--kind sync|summary|embedding|cluster  Restrict to one run table',
      '--limit <count>  Maximum number of records to return',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl runs openclaw/openclaw --limit 20 --json', 'ghcrawl runs openclaw/openclaw --kind cluster --json'],
    agentJson: true,
  },
  {
    name: 'threads',
    synopsis: 'threads <owner/repo> [--numbers <n,n,...>] [--kind issue|pull_request] [--include-closed] [--json]',
    description: 'Read specific local issue and PR records from SQLite.',
    options: [
      '--numbers <n,n,...>  Fetch one or more thread numbers in one call',
      '--kind issue|pull_request  Filter by issue or pull request',
      '--include-closed  Include locally closed items',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl threads openclaw/openclaw --numbers 42,43,44 --json', 'ghcrawl threads openclaw/openclaw --numbers 42 --include-closed --json'],
    agentJson: true,
  },
  {
    name: 'close-thread',
    synopsis: 'close-thread <owner/repo> --number <thread> [--json]',
    description: 'Mark one local issue or PR closed immediately.',
    options: ['--number <thread>  Thread number to close locally', '--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl close-thread openclaw/openclaw --number 42 --json'],
    agentJson: true,
  },
  {
    name: 'close-cluster',
    synopsis: 'close-cluster <owner/repo> --id <cluster-id> [--json]',
    description: 'Mark one local cluster closed immediately.',
    options: ['--id <cluster-id>  Cluster id to close locally', '--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl close-cluster openclaw/openclaw --id 123 --json'],
    agentJson: true,
  },
  {
    name: 'exclude-cluster-member',
    synopsis: 'exclude-cluster-member <owner/repo> --id <cluster-id> --number <thread> [--reason <text>] [--json]',
    description: 'Remove one issue or PR from a durable cluster and block automatic re-entry.',
    options: [
      '--id <cluster-id>  Durable cluster id',
      '--number <thread>  Issue or PR number to exclude',
      '--reason <text>  Optional maintainer reason',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl exclude-cluster-member openclaw/openclaw --id 123 --number 42 --reason "false positive" --json'],
    agentJson: true,
  },
  {
    name: 'include-cluster-member',
    synopsis: 'include-cluster-member <owner/repo> --id <cluster-id> --number <thread> [--reason <text>] [--json]',
    description: 'Add one issue or PR to a durable cluster and keep it included across rebuilds.',
    options: [
      '--id <cluster-id>  Durable cluster id',
      '--number <thread>  Issue or PR number to include',
      '--reason <text>  Optional maintainer reason',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl include-cluster-member openclaw/openclaw --id 123 --number 42 --reason "same root cause" --json'],
    agentJson: true,
  },
  {
    name: 'set-cluster-canonical',
    synopsis: 'set-cluster-canonical <owner/repo> --id <cluster-id> --number <thread> [--reason <text>] [--json]',
    description: 'Pin one durable cluster member as the canonical representative.',
    options: [
      '--id <cluster-id>  Durable cluster id',
      '--number <thread>  Issue or PR number to mark canonical',
      '--reason <text>  Optional maintainer reason',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl set-cluster-canonical openclaw/openclaw --id 123 --number 42 --reason "best root issue" --json'],
    agentJson: true,
  },
  {
    name: 'merge-clusters',
    synopsis: 'merge-clusters <owner/repo> --source <cluster-id> --target <cluster-id> [--reason <text>] [--json]',
    description: 'Merge one durable cluster into another and preserve the source slug as an alias.',
    options: [
      '--source <cluster-id>  Durable cluster id to merge from',
      '--target <cluster-id>  Durable cluster id to merge into',
      '--reason <text>  Optional maintainer reason',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl merge-clusters openclaw/openclaw --source 123 --target 456 --reason "same root cause" --json'],
    agentJson: true,
  },
  {
    name: 'split-cluster',
    synopsis: 'split-cluster <owner/repo> --source <cluster-id> --numbers <n,n,...> [--reason <text>] [--json]',
    description: 'Split selected active members into a new durable cluster and block automatic re-entry into the source.',
    options: [
      '--source <cluster-id>  Durable cluster id to split from',
      '--numbers <n,n,...>  Issue or PR numbers to move into the new cluster',
      '--reason <text>  Optional maintainer reason',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl split-cluster openclaw/openclaw --source 123 --numbers 42,43 --reason "separate root cause" --json'],
    agentJson: true,
  },
  {
    name: 'embed',
    synopsis: 'embed <owner/repo> [--number <thread>] [--json]',
    description: 'Generate or refresh embeddings for one repo or one thread.',
    options: ['--number <thread>  Restrict embedding work to one thread', '--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl embed openclaw/openclaw --json', 'ghcrawl embed openclaw/openclaw --number 42 --json'],
    agentJson: true,
  },
  {
    name: 'key-summaries',
    synopsis: 'key-summaries <owner/repo> [--number <thread>] [--limit <count>] [--json]',
    description: 'Generate cached structured LLM key summaries for clustering enrichment.',
    options: [
      '--number <thread>  Restrict key summary work to one thread',
      '--limit <count>  Limit the number of generated summaries',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl key-summaries openclaw/openclaw --limit 25 --json'],
    agentJson: true,
  },
  {
    name: 'cluster',
    synopsis: 'cluster <owner/repo> [--number <thread>] [--k <count>] [--threshold <score>] [--max-cluster-size <count>] [--heap-snapshot-dir <dir>] [--heap-log-interval-ms <ms>] [--json]',
    description: 'Build or refresh local similarity clusters.',
    options: [
      '--number <thread>  Refresh only one durable cluster neighborhood',
      '--k <count>  Limit nearest-neighbor fanout',
      '--threshold <score>  Minimum similarity score',
      '--max-cluster-size <count>  Soft cap for automatic cluster components before starting a new component',
      '--heap-snapshot-dir <dir>  Write heap snapshots during long-running work',
      '--heap-log-interval-ms <ms>  Emit periodic heap diagnostics',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl cluster openclaw/openclaw --json', 'ghcrawl cluster openclaw/openclaw --number 42 --threshold 0.82 --json'],
    agentJson: true,
  },
  {
    name: 'clusters',
    synopsis: 'clusters <owner/repo> [--min-size <count>] [--limit <count>] [--sort recent|size] [--search <text>] [--hide-closed] [--json]',
    description: 'List local cluster summaries for one repository.',
    options: [
      '--min-size <count>  Minimum cluster size to return',
      '--limit <count>  Maximum number of clusters to return',
      '--sort recent|size  Sort by recency or cluster size',
      '--search <text>  Filter clusters by text',
      '--hide-closed  Hide locally closed clusters',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl clusters openclaw/openclaw --min-size 5 --limit 20 --sort recent --json'],
    agentJson: true,
  },
  {
    name: 'cluster-detail',
    synopsis: 'cluster-detail <owner/repo> --id <cluster-id> [--member-limit <count>] [--body-chars <count>] [--hide-closed] [--json]',
    description: 'Dump one local cluster and its members.',
    options: [
      '--id <cluster-id>  Cluster id to inspect',
      '--member-limit <count>  Limit member rows in the response',
      '--body-chars <count>  Limit body snippet size',
      '--hide-closed  Hide locally closed clusters',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl cluster-detail openclaw/openclaw --id 123 --member-limit 20 --body-chars 280 --json'],
    agentJson: true,
  },
  {
    name: 'cluster-explain',
    synopsis: 'cluster-explain <owner/repo> --id <cluster-id> [--member-limit <count>] [--event-limit <count>] [--json]',
    description: 'Explain one durable cluster with evidence, overrides, aliases, and event history.',
    options: [
      '--id <cluster-id>  Durable cluster id to inspect',
      '--member-limit <count>  Limit member rows and evidence scope',
      '--event-limit <count>  Limit event history rows',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl cluster-explain openclaw/openclaw --id 123 --member-limit 20 --event-limit 50 --json'],
    agentJson: true,
  },
  {
    name: 'durable-clusters',
    synopsis: 'durable-clusters <owner/repo> [--include-inactive] [--member-limit <count>] [--json]',
    description: 'List persistent cluster identities, stable slugs, and governed memberships.',
    options: [
      '--include-inactive  Include closed, merged, and split durable clusters',
      '--member-limit <count>  Limit returned members per cluster',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl durable-clusters openclaw/openclaw --member-limit 10 --json'],
    agentJson: true,
  },
  {
    name: 'search',
    synopsis: 'search <owner/repo> --query <text> [--mode keyword|semantic|hybrid] [--json]',
    description: 'Search local cluster and thread data.',
    options: [
      '--query <text>  Query string to search for',
      '--mode keyword|semantic|hybrid  Choose search mode explicitly',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl search openclaw/openclaw --query "download stalls" --mode hybrid --json'],
    agentJson: true,
  },
  {
    name: 'neighbors',
    synopsis: 'neighbors <owner/repo> --number <thread> [--limit <count>] [--threshold <score>] [--json]',
    description: 'List nearest semantic matches for one thread.',
    options: [
      '--number <thread>  Thread number to inspect',
      '--limit <count>  Maximum number of neighbors to return',
      '--threshold <score>  Minimum similarity score',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl neighbors openclaw/openclaw --number 42 --limit 10 --json'],
    agentJson: true,
  },
  {
    name: 'tui',
    synopsis: 'tui [owner/repo]',
    description: 'Start the interactive terminal UI.',
    options: [],
    examples: ['ghcrawl tui', 'ghcrawl tui openclaw/openclaw'],
  },
  {
    name: 'serve',
    synopsis: 'serve [--port <port>]',
    description: 'Start the local HTTP API server.',
    options: ['--port <port>  Override the configured local API port'],
    examples: ['ghcrawl serve', 'ghcrawl serve --port 5179'],
  },
  {
    name: 'summarize',
    synopsis: 'summarize <owner/repo> [--number <thread>] [--include-comments]',
    description: 'Generate or refresh summaries for local thread content.',
    options: ['--number <thread>  Restrict summary work to one thread', '--include-comments  Include comments in the summary input'],
    examples: ['ghcrawl --dev summarize openclaw/openclaw', 'ghcrawl --dev summarize openclaw/openclaw --number 42 --include-comments'],
    devOnly: true,
  },
  {
    name: 'purge-comments',
    synopsis: 'purge-comments <owner/repo> [--number <thread>]',
    description: 'Delete stored comments for one repo or one thread.',
    options: ['--number <thread>  Restrict purge to one thread'],
    examples: ['ghcrawl --dev purge-comments openclaw/openclaw', 'ghcrawl --dev purge-comments openclaw/openclaw --number 42'],
    devOnly: true,
  },
];

function visibleCommandSpecs(devMode: boolean): CommandSpec[] {
  return COMMAND_SPECS.filter((spec) => devMode || spec.devOnly !== true);
}

export function getCommandSpec(name: string, devMode: boolean): CommandSpec | undefined {
  return visibleCommandSpecs(devMode).find((spec) => spec.name === name);
}

function renderCommandList(devMode: boolean): string[] {
  const specs = visibleCommandSpecs(devMode);
  const width = Math.max(...specs.map((spec) => spec.name.length));
  return specs.map((spec) => `  ${spec.name.padEnd(width)}  ${spec.description}`);
}

function commonGlobalOptions(): string[] {
  return [
    '--config-path <path>  Override the persisted config.json path',
    '--workspace-root <path>  Override workspace root detection for .env.local and data/ghcrawl.db',
    '--dev  Enable dev-only commands and help output',
  ];
}

export function usage(devMode = false): string {
  const lines = [
    'ghcrawl <command> [options]',
    '',
    'Commands:',
    ...renderCommandList(devMode),
    '',
    'Global options:',
    ...commonGlobalOptions().map((line) => `  ${line}`),
    '',
    "Use 'ghcrawl help <command>' or 'ghcrawl <command> --help' for details.",
  ];
  return `${lines.join('\n')}\n`;
}

export function commandUsage(spec: CommandSpec): string {
  const lines = [`ghcrawl ${spec.synopsis}`, '', spec.description];
  if (spec.options.length > 0) {
    lines.push('', 'Options:', ...spec.options.map((line) => `  ${line}`));
  }
  lines.push('', 'Global options:', ...commonGlobalOptions().map((line) => `  ${line}`));
  if (spec.agentJson) {
    lines.push('', 'Machine output:', '  Supports explicit --json. JSON remains the default in this compatibility pass.');
  }
  lines.push('', 'Examples:', ...spec.examples.map((example) => `  ${example}`));
  return `${lines.join('\n')}\n`;
}

export function hasHelpFlag(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export function usageHint(command?: CommandName): string {
  return command ? `Run 'ghcrawl ${command} --help' for usage.` : "Run 'ghcrawl --help' for usage.";
}
