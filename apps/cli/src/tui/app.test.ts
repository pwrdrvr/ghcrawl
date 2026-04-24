import test from 'node:test';
import assert from 'node:assert/strict';

import type { TuiClusterDetail, TuiThreadDetail } from '@ghcrawl/api-core';

import {
  buildHelpContent,
  escapeBlessedText,
  formatClusterDateColumn,
  formatClusterListLabel,
  formatClusterShortName,
  getRepositoryChoices,
  parseOwnerRepoValue,
  renderDetailPane,
  resolveBlessedTerminal,
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
      body: 'Body with {red-fg}tags{/red-fg}',
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
  assert.match(rendered, /Cluster 1 \(#42 representative issue\)/);
  assert.match(rendered, /Bad \\{bold\\}title\\{\/bold\\}/);
  assert.match(rendered, /LLM Summary:/);
  assert.match(rendered, /Body with \\{red-fg\\}tags\\{\/red-fg\\}/);
  assert.match(rendered, /Summary \\{yellow-fg\\}text\\{\/yellow-fg\\}/);
  assert.match(rendered, /Neighbor \\{blue-fg\\}title\\{\/blue-fg\\}/);
  assert.ok(rendered.indexOf('LLM Summary:') < rendered.indexOf('{bold}Body{/bold}'));
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

test('formatClusterListLabel keeps counts first and adds a short cluster name', () => {
  const label = formatClusterListLabel({
    clusterId: 1507,
    displayTitle: 'Fix: dedupe section title/desc in single-section config view',
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

  assert.match(label, /3 items\s+C1507\s+3P\/0I\s+04-24 07:29\s+Fix: dedupe section/);
});

test('formatClusterShortName returns the first meaningful words', () => {
  assert.equal(formatClusterShortName('[codex] fix agent session-id routing'), 'codex fix agent');
  assert.equal(formatClusterShortName(''), 'untitled');
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
  assert.match(content, /Mouse clicks focus panes/);
  assert.match(content, /p\s+open the repository browser/);
  assert.match(content, /l\s+toggle wide layout/);
  assert.match(content, /x\s+show or hide locally closed clusters and members/);
  assert.match(content, /h or \?\s+open this help popup/);
  assert.match(content, /q\s+quit the TUI/);
  assert.doesNotMatch(content, /j \/ k/);
  assert.match(content, /This popup scrolls\./);
});
