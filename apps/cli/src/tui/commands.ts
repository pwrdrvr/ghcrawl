import type { TuiScreenId } from './state.js';

export type TuiCommandAvailability = {
  enabled: boolean;
  reason?: string;
};

export type TuiCommandDefinition<TContext = void> = {
  id: string;
  slash: string;
  label: string;
  description: string;
  aliases?: string[];
  screens?: TuiScreenId[];
  isVisible?: (context: TContext) => boolean;
  getAvailability?: (context: TContext) => TuiCommandAvailability;
  execute: () => void;
};

export type TuiResolvedCommand<TContext = void> = {
  definition: TuiCommandDefinition<TContext>;
  enabled: boolean;
  reason: string | null;
  rank: number;
  order: number;
};

export function normalizeSlashQuery(value: string): string {
  return value.trim().replace(/^\/+/, '').toLowerCase();
}

export function resolveCommands<TContext>(
  commands: readonly TuiCommandDefinition<TContext>[],
  context: TContext,
): TuiResolvedCommand<TContext>[] {
  const resolved: TuiResolvedCommand<TContext>[] = [];
  const activeScreen =
    typeof context === 'object' && context !== null && 'activeScreen' in context
      ? ((context as { activeScreen?: TuiScreenId }).activeScreen ?? null)
      : null;
  for (const [order, definition] of commands.entries()) {
    if (definition.screens && activeScreen && !definition.screens.includes(activeScreen)) {
      continue;
    }
    if (definition.isVisible && !definition.isVisible(context)) {
      continue;
    }
    const availability = definition.getAvailability?.(context) ?? { enabled: true };
    resolved.push({
      definition,
      enabled: availability.enabled,
      reason: availability.reason ?? null,
      rank: Number.POSITIVE_INFINITY,
      order,
    });
  }
  return resolved;
}

export function filterCommands<TContext>(
  commands: readonly TuiResolvedCommand<TContext>[],
  query: string,
): TuiResolvedCommand<TContext>[] {
  const normalizedQuery = normalizeSlashQuery(query);
  const ranked = commands
    .map((command) => ({ command, rank: getCommandRank(command.definition, normalizedQuery) }))
    .filter((entry) => entry.rank !== null)
    .map(({ command, rank }) => ({ ...command, rank: rank ?? Number.POSITIVE_INFINITY }));

  ranked.sort((left, right) => left.rank - right.rank || left.order - right.order || left.definition.slash.localeCompare(right.definition.slash));
  return ranked;
}

export function selectCommandFromQuery<TContext>(
  commands: readonly TuiResolvedCommand<TContext>[],
  query: string,
  selectedIndex: number,
): TuiResolvedCommand<TContext> | null {
  const filtered = filterCommands(commands, query);
  if (filtered.length === 0) {
    return null;
  }

  const exact = filtered.find((command) => isExactCommandMatch(command.definition, query));
  if (exact) {
    return exact;
  }

  return filtered[Math.max(0, Math.min(selectedIndex, filtered.length - 1))] ?? filtered[0] ?? null;
}

export function formatCommandLabel<TContext>(command: TuiResolvedCommand<TContext>): string {
  const base = `/${command.definition.slash}  ${command.definition.description}`;
  if (command.enabled) {
    return base;
  }
  const suffix = command.reason ? ` (${command.reason})` : ' (unavailable)';
  return `{gray-fg}${escapeCommandText(base + suffix)}{/gray-fg}`;
}

export function isExactCommandMatch<TContext>(
  command: TuiCommandDefinition<TContext>,
  query: string,
): boolean {
  const normalizedQuery = normalizeSlashQuery(query);
  if (!normalizedQuery) return false;
  return getCommandTokens(command).includes(normalizedQuery);
}

function getCommandRank<TContext>(command: TuiCommandDefinition<TContext>, query: string): number | null {
  if (!query) {
    return 0;
  }

  const slash = command.slash.toLowerCase();
  const tokens = getCommandTokens(command);
  const label = command.label.toLowerCase();
  const description = command.description.toLowerCase();

  if (tokens.includes(query)) return 0;
  if (slash.startsWith(query)) return 1;
  if (tokens.some((token) => token.startsWith(query))) return 2;
  if (label.startsWith(query)) return 3;
  if (tokens.some((token) => token.includes(query)) || label.includes(query) || description.includes(query)) return 4;
  if (tokens.some((token) => isSubsequenceMatch(token, query)) || isSubsequenceMatch(label, query)) return 5;
  return null;
}

function getCommandTokens<TContext>(command: TuiCommandDefinition<TContext>): string[] {
  return [command.id, command.slash, ...(command.aliases ?? [])].map((value) => value.toLowerCase());
}

function isSubsequenceMatch(candidate: string, query: string): boolean {
  if (!query) return true;
  let candidateIndex = 0;
  for (const queryChar of query) {
    candidateIndex = candidate.indexOf(queryChar, candidateIndex);
    if (candidateIndex === -1) {
      return false;
    }
    candidateIndex += 1;
  }
  return true;
}

function escapeCommandText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}
