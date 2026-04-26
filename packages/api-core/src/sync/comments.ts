import { isBotLikeAuthor } from '../documents/normalize.js';
import type { GitHubClient, GitHubReporter } from '../github/client.js';
import type { CommentSeed } from '../service-types.js';
import { asJson, userLogin, userType } from '../service-utils.js';

export async function fetchThreadComments(params: {
  github: GitHubClient;
  owner: string;
  repo: string;
  number: number;
  isPr: boolean;
  reporter?: GitHubReporter;
}): Promise<CommentSeed[]> {
  const comments: CommentSeed[] = [];

  const issueComments = await params.github.listIssueComments(params.owner, params.repo, params.number, params.reporter);
  comments.push(
    ...issueComments.map((comment) => {
      const authorLogin = userLogin(comment);
      const authorType = userType(comment);
      return {
        githubId: String(comment.id),
        commentType: 'issue_comment',
        authorLogin,
        authorType,
        body: String(comment.body ?? ''),
        isBot: isBotLikeAuthor({ authorLogin, authorType }),
        rawJson: asJson(comment),
        createdAtGh: typeof comment.created_at === 'string' ? comment.created_at : null,
        updatedAtGh: typeof comment.updated_at === 'string' ? comment.updated_at : null,
      };
    }),
  );

  if (params.isPr) {
    const reviews = await params.github.listPullReviews(params.owner, params.repo, params.number, params.reporter);
    comments.push(
      ...reviews.map((review) => {
        const authorLogin = userLogin(review);
        const authorType = userType(review);
        return {
          githubId: String(review.id),
          commentType: 'review',
          authorLogin,
          authorType,
          body: String(review.body ?? review.state ?? ''),
          isBot: isBotLikeAuthor({ authorLogin, authorType }),
          rawJson: asJson(review),
          createdAtGh: typeof review.submitted_at === 'string' ? review.submitted_at : null,
          updatedAtGh: typeof review.submitted_at === 'string' ? review.submitted_at : null,
        };
      }),
    );

    const reviewComments = await params.github.listPullReviewComments(
      params.owner,
      params.repo,
      params.number,
      params.reporter,
    );
    comments.push(
      ...reviewComments.map((comment) => {
        const authorLogin = userLogin(comment);
        const authorType = userType(comment);
        return {
          githubId: String(comment.id),
          commentType: 'review_comment',
          authorLogin,
          authorType,
          body: String(comment.body ?? ''),
          isBot: isBotLikeAuthor({ authorLogin, authorType }),
          rawJson: asJson(comment),
          createdAtGh: typeof comment.created_at === 'string' ? comment.created_at : null,
          updatedAtGh: typeof comment.updated_at === 'string' ? comment.updated_at : null,
        };
      }),
    );
  }

  return comments;
}
