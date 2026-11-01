import type { Message, RouteType } from '../../types';
import SourceCardList from '../SourceCard/SourceCard';
import { Sparkles, FileText, Info } from 'lucide-react';
import { renderMarkdown } from './renderMarkdown';
import './MessageBubble.css';
import { useState } from 'react';

const ROUTE_LABELS: Record<RouteType, string> = {
  POSTHARVEST: 'Post-Harvest Management',
  GENERAL_RAG: 'Cultivation Research',
  MEMORY_UPDATE: 'Memory Updated',
};

// ── Parsed section interface ─────────────────────────────────────────────────
interface ParsedSections {
  directAnswer?: { header: string; body: string };
  evidence?: { header: string; body: string };
  scope?: { header: string; body: string };
  isStructured: boolean;
}

interface StructuredGeneralResponse {
  query_intent?: string;
  direct_answer: string;
  /** New contract — what research reports */
  research_findings?: Array<{
    factor: string;
    finding: string;
    evidence_strength?: string;
    source_ids: string[];
    evidence_ids?: string[];
  }>;
  /** New contract — practical interpretation from findings */
  farmer_guidance?: Array<{ text: string; source_ids?: string[] }>;
  /** Legacy fallback */
  factors: Array<{
    factor: string;
    finding: string;
    evidence_strength?: string;
    farmer_interpretation?: string;
    source_ids: string[];
    /** compact E-IDs from LLM — may be present before resolution */
    evidence_ids?: string[];
  }>;
  /** new contract legacy compat */
  farmer_interpretation?: Array<{ recommendation: string; evidence_ids?: string[]; source_ids?: string[] }>;
  /** legacy */
  farmer_actions?: Array<{ action: string; source_ids: string[] }>;
  limitations?: string;
  caution?: string;
  supporting_evidence?: Array<{
    factor: string;
    paper_title: string;
    classification: string;
    key_finding: string;
    experimental_conditions: string;
    source_id: string;
  }>;
}

function parseStructuredResponse(content: string): StructuredGeneralResponse | null {
  if (!content.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(content) as StructuredGeneralResponse;
    if (
      typeof parsed.direct_answer !== 'string' ||
      !Array.isArray(parsed.factors)
    ) return null;
    if (parsed.factors.some((item) =>
      !item.factor || !item.finding,
    )) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cleanFarmerText(text: string): string {
  return text
    .replace(/^#{1,6}\s*(?:Factors influencing flowering and yield|How flower production may be improved|Vegetative growth findings|Evidence limitations)\s*$/gim, '')
    .replace(/\[Source document:[^\]]+\]/gi, '')
    .replace(/\bSource document:\s*[^\n,)]+/gi, '')
    .replace(/\b(?:Paper Title|Evidence classification|Key Finding|Experimental Conditions|Reported Outcome)\s*:/gi, '')
    .replace(/\b(?:Factor [AB]|SE\s*\(m\)|CD at 5%)\b[^.\n]*/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

function synthesizeFarmerAnswer(rawBody: string): string {
  const cleaned = cleanFarmerText(rawBody);
  const isPostHarvest = /\b(?:post[- ]harvest|postharvest|packaging|package|packing|storage|cold storage|shelf[- ]life|shelf life|chitosan|boric acid|transport|preservation|polythene|mycelium)\b/i.test(rawBody);

  // For post-harvest queries, display the complete answer without truncating in the middle of words or sentences
  if (isPostHarvest && cleaned.length > 0) {
    const hasCaution = /⚠️|study-specific|universal recommendation/i.test(cleaned);
    return hasCaution
      ? cleaned
      : `${cleaned}\n\n⚠️ These are study-specific findings, not universal recommendations.`;
  }

  const lines = cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 20)
    .filter((line) => !/^(?:source|species|cultivar|category|location|conditions?)\s*:/i.test(line));
  const sourceText = lines.length > 0 ? lines.join(' ') : cleaned;
  const sentences = sourceText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 25)
    .filter((sentence) => !/^(?:results of the experiment|baramasi treatments|factor [ab]|table|figure)\b/i.test(sentence));
  const relevant = sentences.filter((sentence) =>
    /\b(?:flower|floral|yield|thiourea|prun|spacing|growth regulat|defoliat|nutrient|nitrogen)\w*/i.test(sentence),
  );
  const selected = [...new Set((relevant.length > 0 ? relevant : sentences).slice(0, 4))]
    .map((sentence) => `• ${sentence}`);

  if (selected.length === 0) {
    return cleaned;
  }

  const introSentence = 'Flowering and yield were linked to the treatments and practices reported in the retrieved studies.';

  return [
    introSentence,
    ...selected,
    '⚠️ These are study-specific findings, not universal recommendations.',
  ].join('\n\n');
}

function normalizeSupportingEvidence(text: string): string {
  return text.replace(
    /###\s*irrigation\s+Evidence/gi,
    '### Pruning / Growth Regulator Evidence',
  );
}

function normalizeEvidenceText(str?: string): string {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseAssistantContent(content: string): ParsedSections {
  const structured = parseStructuredResponse(content);
  if (structured) {
    // Prefer new research_findings; fall back to legacy factors
    const findings = structured.research_findings || structured.factors || [];

    // Build 📚 Research Findings blocks (one per factor, no farmer_interpretation mixed in)
    const researchFindingBlocks = findings.map((item) => {
      const strengthBadge = item.evidence_strength
        ? ` *(${item.evidence_strength.replace(/_/g, ' ').toLowerCase()})*`
        : '';
      return `### ${item.factor}${strengthBadge}\n\n${item.finding}`;
    });

    // Build 🌱 Farmer Guidance items
    // Prefer new farmer_guidance; fall back to farmer_interpretation / farmer_actions
    const guidanceItems: string[] = (() => {
      if (structured.farmer_guidance && structured.farmer_guidance.length > 0) {
        return structured.farmer_guidance.map((g) => g.text);
      }
      if (structured.farmer_interpretation && structured.farmer_interpretation.length > 0) {
        return structured.farmer_interpretation.map((g) => g.recommendation);
      }
      if (structured.farmer_actions && structured.farmer_actions.length > 0) {
        return structured.farmer_actions.map((g) => g.action);
      }
      return [];
    })();

    // Deduplicate: remove guidance items that are identical/near-identical to a research finding
    const findingNorms = findings.map((f) => normalizeEvidenceText(f.finding));
    const uniqueGuidanceItems = guidanceItems.filter((text) => {
      const norm = normalizeEvidenceText(text);
      return norm.length > 0 && !findingNorms.some(
        (fn) => fn === norm || fn.includes(norm) || norm.includes(fn),
      );
    });

    // Compose the Direct Answer body with two clearly separated sections
    const bodyParts: string[] = [structured.direct_answer];

    if (researchFindingBlocks.length > 0) {
      bodyParts.push('## 📚 Research Findings');
      bodyParts.push(researchFindingBlocks.join('\n\n'));
    }

    if (uniqueGuidanceItems.length > 0) {
      bodyParts.push('## 🌱 Farmer Guidance');
      bodyParts.push(uniqueGuidanceItems.map((item) => `• ${item}`).join('\n\n'));
    }

    let caution = structured.limitations || structured.caution || '';
    if (caution && /\bnitrogen\b/i.test(caution)) {
      const factorText = findings.map((f) => `${f.factor} ${f.finding}`).join(' ');
      const actionText = [
        ...(structured.farmer_guidance || []).map((g) => g.text),
        ...(structured.farmer_interpretation || []).map((i) => i.recommendation),
        ...(structured.farmer_actions || []).map((a) => a.action),
      ].join(' ');
      const textWithoutThiourea = `${factorText} ${actionText}`.replace(/\bthiourea\b/gi, '');
      const mentionsNitrogen = /\b(?:nitrogen|nutrient|nutrition|fertilizer|npk|manure|urea|fertigation)\b/i.test(textWithoutThiourea);
      if (!mentionsNitrogen) {
        caution = caution
          .split(/(?<=[.!?])\s+/)
          .filter((s) => !/\bnitrogen\b/i.test(s))
          .join(' ')
          .trim();
      }
    }

    if (caution) {
      bodyParts.push(`⚠️ ${caution}`);
    }

    const evidenceLines = (structured.supporting_evidence || []).map((item) =>
      `### ${item.factor}\n- **Paper Title**: ${item.paper_title}\n- **Evidence classification**: ${item.classification}\n- **Key Finding**: ${item.key_finding}\n- **Experimental Conditions**: ${item.experimental_conditions}\n- **Source**: ${item.source_id}`,
    );

    return {
      directAnswer: {
        header: 'Direct Answer',
        body: bodyParts.filter(Boolean).join('\n\n'),
      },
      evidence: evidenceLines.length
        ? { header: 'Supporting evidence', body: evidenceLines.join('\n\n') }
        : undefined,
      isStructured: true,
    };
  }


  const supportingMarker = content.match(/🔎\s*View supporting evidence\s*/i);
  if (supportingMarker?.index !== undefined) {
    const beforeMarker = content.slice(0, supportingMarker.index).trim();
    const detailedHeading = beforeMarker.search(
      /(?:^|\n)###\s*(?:Vegetative growth findings|Evidence limitations|Evidence from Retrieved Studies|Related Evidence from Retrieved Studies)\b/i,
    );
    const farmerContent = detailedHeading >= 0
      ? beforeMarker.slice(0, detailedHeading).trim()
      : beforeMarker;
    const preMarkerEvidence = detailedHeading >= 0
      ? beforeMarker.slice(detailedHeading).trim()
      : '';
    const postMarkerEvidence = content
      .slice(supportingMarker.index + supportingMarker[0].length)
      .trim();
    const farmerHeading = farmerContent.match(/^###\s*1\.\s*([^\n]+)/i);
    const farmerBody = farmerHeading
      ? farmerContent.slice(farmerHeading[0].length).trim()
      : farmerContent;

    return {
      directAnswer: {
        header: farmerHeading?.[1]?.trim() || 'Direct Answer',
        body: synthesizeFarmerAnswer(farmerBody),
      },
      evidence: preMarkerEvidence || postMarkerEvidence
        ? {
          header: 'Supporting evidence',
          body: normalizeSupportingEvidence(
            [preMarkerEvidence, postMarkerEvidence].filter(Boolean).join('\n\n'),
          ),
        }
        : undefined,
      isStructured: true,
    };
  }

  // Matches both English and Kannada section headings from the backend
  const s1Regex = /###\s*1\.\s*(?:Direct Answer|ನೇರ ಉತ್ತರ[^(]*(?:\([^)]+\))?)/i;
  const s2Regex = /###\s*2\.\s*(?:(?:Related\s+)?Evidence from Retrieved Studies|ಸಂಶೋಧನಾ ಅಧ್ಯಯನಗಳ ಸಾಕ್ಷ್ಯ|ಸಂಬಂಧಿತ ಸಂಶೋಧನಾ ಸಾಕ್ಷ್ಯ)[^\n]*/i;
  const s3Regex = /###\s*3\.\s*(?:Research Scope|ಸಂಶೋಧನಾ ವ್ಯಾಪ್ತಿ)[^\n]*/i;

  const s1Match = content.match(s1Regex);
  const s2Match = content.match(s2Regex);
  const s3Match = content.match(s3Regex);

  if (s1Match && s2Match && s1Match.index !== undefined && s2Match.index !== undefined) {
    const s1Index = s1Match.index;
    const s2Index = s2Match.index;
    const s3Index = s3Match?.index ?? content.length;

    const s1Header = s1Match[0].trim();
    const s1Body = content.slice(s1Index + s1Match[0].length, s2Index).trim();

    const s2Header = s2Match[0].trim();
    const s2Body = content.slice(s2Index + s2Match[0].length, s3Index).trim();

    let scopeSection: { header: string; body: string } | undefined;
    if (s3Match && s3Match.index !== undefined) {
      scopeSection = {
        header: s3Match[0].trim(),
        body: content.slice(s3Match.index + s3Match[0].length).trim(),
      };
    }

    return {
      directAnswer: { header: s1Header, body: synthesizeFarmerAnswer(s1Body) },
      evidence: { header: s2Header, body: normalizeSupportingEvidence(s2Body) },
      scope: scopeSection,
      isStructured: true,
    };
  }

  return { isStructured: false };
}

// ── User Message ─────────────────────────────────────────────────────────────
export function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex justify-end mb-6">
      <div className="max-w-[85%] sm:max-w-[75%] rounded-3xl rounded-br-sm px-5 py-3.5 bg-[var(--bg-message-user)] border border-[var(--border-subtle)] text-[var(--text-primary)] shadow-sm">
        <p className="whitespace-pre-wrap leading-relaxed select-text text-sm sm:text-base">
          {message.content}
        </p>
      </div>
    </div>
  );
}

// ── Assistant Message ─────────────────────────────────────────────────────────
export function AssistantMessage({ message }: { message: Message }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [showResearchSources, setShowResearchSources] = useState(false);
  const parsed = parseAssistantContent(message.content);
  const firstCategory = message.sources?.[0]?.category;
  const categoryLabel =
    firstCategory ||
    (message.route ? ROUTE_LABELS[message.route] : null) ||
    'Jasmine Agronomy';

  return (
    <div className="flex items-start gap-3 sm:gap-4 mb-8 animate-message-fade-in">
      {/* 🌸 Avatar */}
      <div
        className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-[var(--brand-pink-dim)] border border-pink-500/30 flex items-center justify-center text-base sm:text-lg flex-shrink-0 shadow-sm mt-0.5"
        aria-hidden="true"
      >
        🌸
      </div>

      <div className="flex-1 min-w-0 space-y-3">
        {/* Category Badge */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[var(--brand-pink-dim)] text-[var(--brand-pink)] border border-pink-500/30 tracking-wide">
            🌸 <span>{categoryLabel}</span>
          </span>
        </div>

        {/* Structured Card Hierarchy */}
        {parsed.isStructured && parsed.directAnswer ? (
          <div className="space-y-3">
            {/* 1. Direct Answer Card */}
            <div className="rounded-2xl bg-[var(--bg-surface)] border-l-4 border-l-emerald-500 border border-[var(--border)] p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
                <Sparkles className="w-3.5 h-3.5" />
                <span>{parsed.directAnswer.header.replace(/^#+\s*\d+\.\s*/, '')}</span>
              </div>
              <div className="text-sm sm:text-base leading-relaxed">
                {renderMarkdown(parsed.directAnswer.body)}
              </div>
            </div>

            {parsed.evidence?.body && (
              <>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-3.5 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:border-emerald-500/50 hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  onClick={() => setShowEvidence((previous) => !previous)}
                  aria-expanded={showEvidence}
                  aria-controls={`supporting-evidence-${message.messageId}`}
                >
                  {showEvidence ? '🔽 Hide supporting evidence' : '🔎 View supporting evidence'}
                </button>

                {showEvidence && (
                  <div
                    id={`supporting-evidence-${message.messageId}`}
                    className="space-y-3"
                  >
                    <div className="rounded-2xl bg-[var(--bg-card)] border border-[var(--border)] p-4 shadow-sm">
                      <div className="flex items-center gap-2 mb-2.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                        <FileText className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{parsed.evidence.header.replace(/^#+\s*\d+\.\s*/, '')}</span>
                      </div>
                      <div className="text-sm leading-relaxed">
                        {renderMarkdown(parsed.evidence.body)}
                      </div>
                    </div>

                    {parsed.scope?.body && (
                      <div className="rounded-xl bg-[var(--bg-card-subtle)] border border-[var(--border-subtle)] px-4 py-3 text-xs text-[var(--text-secondary)] flex items-start gap-2.5">
                        <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                        <div className="italic leading-relaxed flex-1">
                          {renderMarkdown(parsed.scope.body)}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /* Unstructured / general fallback */
          <div className="rounded-2xl bg-[var(--bg-card)] border border-[var(--border)] p-4 sm:p-5 shadow-sm text-sm sm:text-base leading-relaxed">
            {renderMarkdown(message.content)}
          </div>
        )}

        {message.sources && message.sources.length > 0 && (
          <>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-3.5 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:border-emerald-500/50 hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              onClick={() => setShowResearchSources((previous) => !previous)}
              aria-expanded={showResearchSources}
              aria-controls={`research-sources-${message.messageId}`}
            >
              {showResearchSources ? '📕 Hide research sources' : '📚 View research sources'}
            </button>

            {showResearchSources && (
              <div id={`research-sources-${message.messageId}`} className="research-sources">
                {message.evidenceStatus && (
                  <SourceCardList
                    sources={message.sources}
                    status={message.evidenceStatus}
                    topScore={message.topScore}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Default: routes to the right component ───────────────────────────────────
interface MessageBubbleProps {
  message: Message;
  isTyping?: boolean;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === 'user') {
    return <UserMessage message={message} />;
  }
  return <AssistantMessage message={message} />;
}
