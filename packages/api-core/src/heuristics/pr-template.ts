export const PULL_REQUEST_TEMPLATE_SECTION_START_MARKER = '## Summary';
export const PULL_REQUEST_TEMPLATE_SECTION_END_MARKER = '## Risks and Mitigations';

export type PrTemplateSectionMatch = {
  templateSection: string;
  bodySection: string | null;
  startOffset: number | null;
  endOffset: number | null;
};

export function normalizePrTemplateText(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

export function findExactTemplateOffset(body: string, template: string): number | null {
  if (!template) {
    return null;
  }
  const offset = body.indexOf(template);
  return offset >= 0 ? offset : null;
}

export function extractPrTemplateSection(body: string, template: string): PrTemplateSectionMatch {
  const templateStartOffset = template.indexOf(PULL_REQUEST_TEMPLATE_SECTION_START_MARKER);
  const templateEndOffset = template.indexOf(PULL_REQUEST_TEMPLATE_SECTION_END_MARKER, templateStartOffset);
  const templateSection =
    templateStartOffset >= 0 && templateEndOffset >= 0
      ? template.slice(templateStartOffset)
      : template;

  const bodyStartOffset = body.indexOf(PULL_REQUEST_TEMPLATE_SECTION_START_MARKER);
  if (bodyStartOffset < 0 || templateEndOffset < 0) {
    return {
      templateSection,
      bodySection: null,
      startOffset: null,
      endOffset: null,
    };
  }

  const templateTail = template.slice(templateEndOffset);
  const bodyTailOffset = body.indexOf(templateTail, bodyStartOffset);
  if (bodyTailOffset < 0) {
    return {
      templateSection,
      bodySection: null,
      startOffset: bodyStartOffset,
      endOffset: null,
    };
  }

  const bodyEndOffset = bodyTailOffset + templateTail.length;
  return {
    templateSection,
    bodySection: body.slice(bodyStartOffset, bodyEndOffset),
    startOffset: bodyStartOffset,
    endOffset: bodyEndOffset,
  };
}

export function boundedLevenshteinDistance(left: string, right: string, maxDistance: number): number | null {
  if (maxDistance < 0 || !Number.isSafeInteger(maxDistance)) {
    throw new Error(`Invalid maxDistance: ${maxDistance}`);
  }

  if (left === right) {
    return 0;
  }

  const leftLength = left.length;
  const rightLength = right.length;
  if (Math.abs(leftLength - rightLength) > maxDistance) {
    return null;
  }
  if (leftLength === 0) {
    return rightLength <= maxDistance ? rightLength : null;
  }
  if (rightLength === 0) {
    return leftLength <= maxDistance ? leftLength : null;
  }

  let previous = new Array<number>(rightLength + 1);
  let current = new Array<number>(rightLength + 1);
  for (let column = 0; column <= rightLength; column += 1) {
    previous[column] = column;
  }

  const sentinel = maxDistance + 1;
  for (let row = 1; row <= leftLength; row += 1) {
    current.fill(sentinel);
    current[0] = row;

    const minColumn = Math.max(1, row - maxDistance);
    const maxColumn = Math.min(rightLength, row + maxDistance);
    if (minColumn > maxColumn) {
      return null;
    }
    if (minColumn > 1) {
      current[minColumn - 1] = sentinel;
    }

    let rowMin = sentinel;
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      const insertion = current[column - 1] + 1;
      const deletion = previous[column] + 1;
      const substitution = previous[column - 1] + substitutionCost;
      const value = Math.min(insertion, deletion, substitution);
      current[column] = value;
      if (value < rowMin) {
        rowMin = value;
      }
    }

    if (rowMin > maxDistance) {
      return null;
    }

    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[rightLength] <= maxDistance ? previous[rightLength] : null;
}
