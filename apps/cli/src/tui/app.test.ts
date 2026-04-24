import test from 'node:test';
import assert from 'node:assert/strict';

import type { TuiClusterDetail, TuiThreadDetail } from '@ghcrawl/api-core';

import {
  buildThreadContextMenuItems,
  buildHelpContent,
  escapeBlessedText,
  formatClusterDateColumn,
  formatClusterListHeader,
  formatClusterListLabel,
  formatClusterShortName,
  getThreadReferenceLinks,
  getRepositoryChoices,
  parseOwnerRepoValue,
  renderMarkdownForTerminal,
  renderDetailPane,
  resolveBlessedTerminal,
  resolveClusterHeaderSortFromClick,
  renderSummarySections,
  splitClusterDisplayTitle,
} from './app.js';

test('escapeBlessedText escapes blessed tag delimiters', () => {
  assert.equal(escapeBlessedText('{bold}wow{/bold}'), '\\{bold\\}wow\\{/bold\\}');
  assert.equal(escapeBlessedText('path\\name'), 'path\\\\name');
});

test('renderDetailPane escapes user-provided text before rendering into a tags-enabled box', () => {
  const cluster: TuiClusterDetail = {
    clusterId: 1,
    displayTitle: 'Cluster {red-fg}boom{/red-fg}',
    isClosed: false,
    closedAtLocal: null,
    closeReasonLocal: null,
    totalCount: 1,
    issueCount: 1,
    pullRequestCount: 0,
    latestUpdatedAt: '2026-03-09T00:00:00Z',
    representativeThreadId: 1,
    representativeNumber: 42,
    representativeKind: 'issue',
    members: [],
  };
  const detail: TuiThreadDetail = {
    thread: {
      id: 1,
      repoId: 1,
      number: 42,
      kind: 'issue',
      state: 'open',
      isClosed: false,
      closedAtGh: null,
      closedAtLocal: null,
      closeReasonLocal: null,
      title: 'Bad {bold}title{/bold}',
      body: 'Body with {red-fg}tags{/red-fg} and https://example.com/body-link',
      authorLogin: 'dev{cyan-fg}',
      htmlUrl: 'https://example.com/{oops}',
      labels: ['bug{green-fg}'],
      updatedAtGh: '2026-03-09T00:00:00Z',
      clusterId: 1,
    },
    summaries: {
      dedupe_summary: 'Summary {yellow-fg}text{/yellow-fg}',
    },
    neighbors: [
      {
        threadId: 2,
        number: 43,
        kind: 'pull_request',
        title: 'Neighbor {blue-fg}title{/blue-fg}',
        score: 0.9,
      },
    ],
  };

  const rendered = renderDetailPane(detail, cluster, 'detail');
  assert.match(rendered, /C1 \(#42 representative issue\)/);
  assert.match(rendered, /Bad \\{bold\\}title\\{\/bold\\}/);
  assert.match(rendered, /Cluster signal:/);
  assert.match(rendered, /Main/);
  assert.match(rendered, /Body with \\{red-fg\\}tags\\{\/red-fg\\}/);
  assert.match(rendered, /Links/);
  assert.match(rendered, /1\. https:\/\/example\.com\/body-link/);
  assert.match(rendered, /Summary \\{yellow-fg\\}text\\{\/yellow-fg\\}/);
  assert.match(rendered, /Neighbor \\{blue-fg\\}title\\{\/blue-fg\\}/);
  assert.ok(rendered.indexOf('Cluster signal:') < rendered.indexOf('{bold}Main{/bold}'));
});

test('renderDetailPane gives useful empty detail content before a cluster is selected', () => {
  const rendered = renderDetailPane(null, null, 'clusters');

  assert.match(rendered, /No repository selected/);
  assert.match(rendered, /s sort/);
  assert.match(rendered, /right-click any pane/);
});

test('parseOwnerRepoValue accepts owner slash repo values and rejects invalid ones', () => {
  assert.deepEqual(parseOwnerRepoValue('openclaw/openclaw'), { owner: 'openclaw', repo: 'openclaw' });
  assert.equal(parseOwnerRepoValue('openclaw'), null);
});

test('resolveBlessedTerminal normalizes ghostty to xterm-256color', () => {
  assert.equal(resolveBlessedTerminal({ TERM: 'xterm-ghostty' } as NodeJS.ProcessEnv), 'xterm-256color');
  assert.equal(resolveBlessedTerminal({ TERM: 'xterm-256color' } as NodeJS.ProcessEnv), 'xterm-256color');
});

test('formatClusterDateColumn follows locale month/day ordering while keeping fixed time width', () => {
  const iso = '2026-03-10T16:04:00';

  assert.equal(formatClusterDateColumn(iso, 'en-US'), '03-10 16:04');
  assert.equal(formatClusterDateColumn(iso, 'en-GB'), '10-03 16:04');
});

test('formatClusterListLabel keeps counts first and splits cluster name from title', () => {
  const label = formatClusterListLabel({
    clusterId: 1507,
    displayTitle: 'alpha-beta-gamma  Fix: dedupe section title/desc in single-section config view',
    isClosed: false,
    closedAtLocal: null,
    closeReasonLocal: null,
    totalCount: 3,
    issueCount: 0,
    pullRequestCount: 3,
    latestUpdatedAt: '2026-04-24T07:29:02',
    representativeThreadId: 252,
    representativeNumber: 55342,
    representativeKind: 'issue',
    searchText: 'fix dedupe section',
  });

  assert.match(label, /^\s*3\s+alpha-beta-gamma\s+Fix: dedupe section title\/desc/);
  assert.match(label, /0I\/3P/);
  assert.doesNotMatch(label, /items/);
});

test('formatClusterListHeader marks the active clickable sort column', () => {
  assert.match(formatClusterListHeader('size'), /cnt\*/);
  assert.match(formatClusterListHeader('recent'), /updated\*/);
});

test('resolveClusterHeaderSortFromClick maps visible header regions to stable sort choices', () => {
  assert.equal(resolveClusterHeaderSortFromClick(0, 120, 'recent'), 'size');
  assert.equal(resolveClusterHeaderSortFromClick(115, 120, 'size'), 'recent');
  assert.equal(resolveClusterHeaderSortFromClick(24, 120, 'size'), 'recent');
  assert.equal(resolveClusterHeaderSortFromClick(24, 120, 'recent'), 'size');
  assert.equal(resolveClusterHeaderSortFromClick(52, 60, 'size'), 'recent');
});

test('formatClusterShortName returns the first meaningful words', () => {
  assert.equal(formatClusterShortName('[codex] fix agent session-id routing'), 'agent session-id routing');
  assert.equal(formatClusterShortName('fix(agents): exclude volatile inbound metadata'), 'agents exclude volatile');
  assert.equal(formatClusterShortName(''), 'untitled');
});

test('splitClusterDisplayTitle separates stable slug from representative title', () => {
  assert.deepEqual(splitClusterDisplayTitle('alpha-beta-gamma  Fix gateway timeout'), {
    name: 'alpha-beta-gamma',
    title: 'Fix gateway timeout',
  });
  assert.equal(splitClusterDisplayTitle('Fix gateway timeout').name, 'gateway timeout');
});

test('renderMarkdownForTerminal formats common markdown without exposing blessed tags', () => {
  const rendered = renderMarkdownForTerminal(
    ['# Heading {boom}', '- **bold** and `code`', '[site](https://example.com/path)', 'https://example.com/raw'].join('\n'),
  );

  assert.match(rendered, /\{bold\}Heading \\{boom\\}\{\/bold\}/);
  assert.match(rendered, /- \{bold\}bold\{\/bold\} and \{yellow-fg\}code\{\/yellow-fg\}/);
  assert.match(rendered, /site <https:\/\/example\.com\/path>/);
  assert.match(rendered, /https:\/\/example\.com\/raw/);
  assert.doesNotMatch(rendered, /\x1B\]8;;/);
});

test('renderSummarySections orders and labels LLM summaries for scanning', () => {
  const rendered = renderSummarySections({
    dedupe_summary: 'same failure mode',
    problem_summary: '**cron** timeout',
    maintainer_signal_summary: 'needs owner',
    solution_summary: 'raise timeout',
  });

  assert.ok(rendered.indexOf('Purpose:') < rendered.indexOf('Solution:'));
  assert.ok(rendered.indexOf('Solution:') < rendered.indexOf('Maintainer signal:'));
  assert.ok(rendered.indexOf('Maintainer signal:') < rendered.indexOf('Cluster signal:'));
  assert.match(rendered, /\{bold\}cron\{\/bold\} timeout/);
});

test('buildThreadContextMenuItems exposes thread actions for right-click menus', () => {
  const items = buildThreadContextMenuItems({
    thread: {
      id: 1,
      repoId: 1,
      number: 42,
      kind: 'issue',
      state: 'open',
      isClosed: false,
      closedAtGh: null,
      closedAtLocal: null,
      closeReasonLocal: null,
      title: 'Example',
      body: 'See [run](https://example.com/run) and https://example.com/raw.',
      authorLogin: 'dev',
      htmlUrl: 'https://example.com/42',
      labels: [],
      updatedAtGh: '2026-03-09T00:00:00Z',
      clusterId: 1,
    },
    summaries: {},
    neighbors: [],
  });

  assert.deepEqual(
    items.map((item) => item.action),
    ['open', 'copy-url', 'copy-title', 'copy-markdown-link', 'open-first-link', 'copy-first-link', 'load-neighbors', 'close'],
  );
});

test('buildThreadContextMenuItems only closes when no thread is selected', () => {
  assert.deepEqual(buildThreadContextMenuItems(null), [{ label: 'Close', action: 'close' }]);
});

test('getThreadReferenceLinks extracts unique body and summary links', () => {
  const links = getThreadReferenceLinks({
    thread: {
      id: 1,
      repoId: 1,
      number: 42,
      kind: 'issue',
      state: 'open',
      isClosed: false,
      closedAtGh: null,
      closedAtLocal: null,
      closeReasonLocal: null,
      title: 'Example',
      body: 'See [run](https://example.com/run), https://example.com/raw.',
      authorLogin: 'dev',
      htmlUrl: 'https://example.com/42',
      labels: [],
      updatedAtGh: '2026-03-09T00:00:00Z',
      clusterId: 1,
    },
    summaries: {
      dedupe_summary: 'same as https://example.com/raw and https://example.com/summary',
    },
    neighbors: [],
  });

  assert.deepEqual(links, ['https://example.com/run', 'https://example.com/raw', 'https://example.com/summary']);
});

test('getRepositoryChoices sorts by most recent update and includes the new-repo action', () => {
  const service = {
    listRepositories() {
      return {
        repositories: [
          {
            id: 1,
            owner: 'older',
            name: 'repo',
            fullName: 'older/repo',
            githubRepoId: '1',
            updatedAt: '2026-03-08T12:00:00Z',
          },
          {
            id: 2,
            owner: 'newer',
            name: 'repo',
            fullName: 'newer/repo',
            githubRepoId: '2',
            updatedAt: '2026-03-09T12:00:00Z',
          },
        ],
      };
    },
  };

  const choices = getRepositoryChoices(service, new Date('2026-03-09T12:30:00Z'));
  assert.equal(choices[0]?.kind, 'existing');
  assert.equal(choices[0]?.target.owner, 'newer');
  assert.match(choices[0]?.label ?? '', /newer\/repo/);
  assert.equal(choices.at(-1)?.kind, 'new');
});

test('buildHelpContent includes the full key command list', () => {
  const content = buildHelpContent();

  assert.match(content, /Tab \/ Shift-Tab/);
  assert.match(content, /Left \/ Right\s+cycle focus backward or forward across panes/);
  assert.match(content, /Up \/ Down\s+move selection, or scroll detail when detail is focused/);
  assert.match(content, /#\s+jump directly to an issue or PR number/);
  assert.match(content, /TUI only reads local SQLite/);
  assert.match(content, /default cluster filter is 1\+/);
  assert.match(content, /default sort is size/);
  assert.match(content, /m\s+cycle member sort mode/);
  assert.match(content, /click the member header to sort/);
  assert.match(content, /right-click opens pane actions/);
  assert.match(content, /p\s+open the repository browser/);
  assert.match(content, /l\s+toggle wide layout/);
  assert.match(content, /x\s+show or hide locally closed clusters and members/);
  assert.match(content, /h or \?\s+open this help popup/);
  assert.match(content, /q\s+quit the TUI/);
  assert.doesNotMatch(content, /j \/ k/);
  assert.match(content, /This popup scrolls\./);
});
