/**
 * JasmineGPT — Citation & Evidence Reconciler
 * ============================================
 * Enforces a strict 1:1 mapping between the evidence section and cited sources:
 * 1. Every paper used in "Evidence from Retrieved Studies" appears in Sources.
 * 2. Every paper shown in Sources has a corresponding evidence summary in the answer.
 * 3. Removes unused retrieved citations from the Sources list.
 * 4. Preserves original title, author, year, DOI, species, and cultivar exactly as retrieved.
 */

import type { SourceDoc } from '../../types';

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.pdf\b/gi, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether a candidate source is referenced/used in the assistant message.
 */
export function isSourceReferenced(source: SourceDoc, content: string): boolean {
  if (!content) return false;
  const normContent = normalizeText(content);

  // Structured general answers carry claim-level source IDs instead of
  // repeating paper titles in the farmer-facing text.
  try {
    const structured = JSON.parse(content) as {
      research_findings?: Array<{ source_ids?: string[] }>;
      farmer_guidance?: Array<{ source_ids?: string[] }>;
      factors?: Array<{ source_ids?: string[] }>;
      farmer_actions?: Array<{ source_ids?: string[] }>;
      supporting_evidence?: Array<{ source_id?: string }>;
    };
    const structuredIds = [
      ...(structured.research_findings || []).flatMap((item) => item.source_ids || []),
      ...(structured.farmer_guidance || []).flatMap((item) => item.source_ids || []),
      ...(structured.factors || []).flatMap((item) => item.source_ids || []),
      ...(structured.farmer_actions || []).flatMap((item) => item.source_ids || []),
      ...(structured.supporting_evidence || []).map((item) => item.source_id || ''),
    ].map(normalizeText);
    if (structuredIds.some((id) =>
      id && (
        id === normalizeText(source.documentId) ||
        id === normalizeText(source.title) ||
        normalizeText(source.title).includes(id)
      ),
    )) return true;
  } catch {
    // Non-JSON responses use the existing title/author matching below.
  }

  // 1. Check Document ID (e.g. "JAS-SAM-001", "JAS-AUR-001")
  if (source.documentId && source.documentId.length >= 3) {
    const normDocId = normalizeText(source.documentId);
    if (normDocId && normContent.includes(normDocId)) {
      return true;
    }
  }

  // 2. Check Title (full title, prefix, or significant token overlap)
  if (source.title) {
    const normTitle = normalizeText(source.title);
    if (normTitle.length >= 8) {
      // Full title match
      if (normContent.includes(normTitle)) {
        return true;
      }
      // First 32 characters match
      const titlePrefix = normTitle.slice(0, Math.min(32, normTitle.length)).trim();
      if (titlePrefix.length >= 12 && normContent.includes(titlePrefix)) {
        return true;
      }
      // Token overlap match (>=70% of words with length > 3)
      const titleWords = normTitle.split(' ').filter((w) => w.length > 3);
      if (titleWords.length >= 3) {
        const matchingWords = titleWords.filter((w) => normContent.includes(w));
        if (matchingWords.length / titleWords.length >= 0.7) {
          return true;
        }
      }
    }
  }

  // 3. Check Author + Year (e.g. "Jawaharlal et al. (2012)" or "Choudhury et al., 2019")
  if (source.authors && source.year) {
    const firstAuthor = source.authors.split(/\s+et\s+al|\s*,/i)[0].trim().toLowerCase();
    if (firstAuthor.length >= 3) {
      const authorYearPattern = new RegExp(`\\b${firstAuthor}\\b[^\\n]{0,35}\\b${source.year}\\b`, 'i');
      if (authorYearPattern.test(content)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extracts study titles or summaries from the Evidence section of the assistant message.
 */
export function extractEvidenceStudies(content: string): string[] {
  const studies: string[] = [];
  if (!content) return studies;

  // Isolate Section 2: Evidence from Retrieved Studies / Related Evidence from Retrieved Studies
  const evidenceSectionRegex = /(?:###?\s*(?:2\.\s*)?(?:Related\s+)?Evidence(?:[^\n]*))([\s\S]*?)(?:###?\s*(?:3\.\s*)?Research Scope|$)/i;
  const match = content.match(evidenceSectionRegex);
  const sectionText = match ? match[1] : content;

  // Find occurrences of Paper Title
  const paperTitleRegex = /(?:[-*•]?\s*\*\*Paper Title\*\*:?|\*\*Title\*\*:?|\*\*Study\*\*:?)\s*([^\n]+)/gi;
  let titleMatch: RegExpExecArray | null;
  while ((titleMatch = paperTitleRegex.exec(sectionText)) !== null) {
    const title = titleMatch[1].trim();
    if (title.length > 3) {
      studies.push(title);
    }
  }

  return studies;
}

function splitResearchCitations(content: string): {
  answerBody: string;
  heading: string;
  section: string;
  suffix: string;
} {
  const match = content.match(/(^|\n)(###?\s*Research Citations\b[^\n]*)([\s\S]*?)(?=\n###?\s+|\s*$)/i);
  if (!match || match.index === undefined) {
    return { answerBody: content, heading: '', section: '', suffix: '' };
  }

  const start = match.index + (match[1] ? match[1].length : 0);
  const end = start + match[2].length + match[3].length;
  return {
    answerBody: `${content.slice(0, start)}${content.slice(end)}`,
    heading: match[2],
    section: match[3],
    suffix: content.slice(end),
  };
}

function farmerFacingContent(content: string): string {
  const markerIndex = content.indexOf('🔎 View supporting evidence');
  return markerIndex >= 0 ? content.slice(0, markerIndex) : content;
}

function sourceMatchesCitationLine(source: SourceDoc, line: string): boolean {
  const normalizedLine = normalizeText(line);
  const candidates = [source.documentId, source.title].filter(Boolean);
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeText(candidate);
    return normalizedCandidate.length >= 3 && normalizedLine.includes(normalizedCandidate);
  });
}

function rewriteResearchCitations(
  content: string,
  referencedSources: SourceDoc[],
): string {
  const split = splitResearchCitations(content);
  if (!split.heading) return content;

  const retainedLines = split.section
    .split('\n')
    .filter((line) => line.trim() && referencedSources.some((source) => sourceMatchesCitationLine(source, line)));

  const citationLines = retainedLines.length > 0
    ? retainedLines
    : referencedSources.map((source) => `- [${source.title}]`);
  const citationSection = `${split.heading}\n${citationLines.join('\n')}`;

  return `${split.answerBody.trimEnd()}\n\n${citationSection}${split.suffix}`;
}

/**
 * Reconciles Sources and Evidence to guarantee a strict 1:1 mapping:
 * - Keeps only candidate sources that are actually summarized in the response.
 * - Filters out unused candidate citations.
 * - Ensures original metadata is preserved verbatim.
 */
export function reconcileSourcesAndEvidence(
  assistantContent: string,
  candidateSources: SourceDoc[],
): {
  reconciledContent: string;
  reconciledSources: SourceDoc[];
  evidenceCount: number;
  sourceCount: number;
} {
  // If response is insufficient evidence, sources must be empty
  if (
    assistantContent.includes('The available research does not provide sufficient evidence.') ||
    candidateSources.length === 0
  ) {
    return {
      reconciledContent: assistantContent,
      reconciledSources: [],
      evidenceCount: 0,
      sourceCount: 0,
    };
  }

  // Ignore the citation list while determining whether a source supports
  // content in the answer. Otherwise a source can validate itself merely by
  // appearing in "Research Citations".
  const { answerBody } = splitResearchCitations(assistantContent);
  const farmerAnswer = farmerFacingContent(answerBody);

  // Match each candidate source against the answer body
  const referencedSources: SourceDoc[] = [];
  const seenSourceKeys = new Set<string>();

  for (const source of candidateSources) {
    const sourceKey = source.documentId || source.title;
    if (seenSourceKeys.has(sourceKey)) continue;

    if (isSourceReferenced(source, farmerAnswer)) {
      referencedSources.push(source);
      seenSourceKeys.add(sourceKey);
    }
  }

  const evidenceStudies = extractEvidenceStudies(answerBody);
  const evidenceCount = evidenceStudies.length > 0 ? evidenceStudies.length : referencedSources.length;

  return {
    reconciledContent: rewriteResearchCitations(assistantContent, referencedSources),
    reconciledSources: referencedSources,
    evidenceCount,
    sourceCount: referencedSources.length,
  };
}
