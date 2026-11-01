/**
 * JasmineGPT — Chat Controller (Orchestrator)
 * =============================================
 * Coordinates the full pipeline for a single conversational turn:
 *
 *   1. Validate request
 *   2. Load conversation memory + recent turns
 *   3. Resolve follow-up → standalone query (deterministic)
 *   4. Route question (MEMORY_UPDATE | GENERAL_RAG | POSTHARVEST)
 *   5. Call RAG sidecar (if not MEMORY_UPDATE)
 *   6. Validate evidence (gate LLM call)
 *   7. Call LLM (only if evidence is supported)
 *   8. Save user + assistant messages to MongoDB
 *   9. Update conversation memory
 *  10. Return structured response
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';
import { env } from '../config/env';
import { routeQuestion } from '../services/router/questionRouter';
import { resolveFollowup } from '../services/router/contextResolver';
import { retrieveGeneral, retrievePostHarvest } from '../services/rag/ragClient';
import {
  callLLM,
  isLlmConfigured,
  callStructuredGeneralLLM,
  buildPostHarvestPrompt,
  buildGeneralPrompt,
  extractGeneralEvidence,
  buildGeneralEvidenceCoverage,
  buildGeneralEvidenceItems,
  buildRankedSynthesisEvidence,
  detectQueryIntent,
  type GeneralEvidenceObject,
  type GeneralStructuredResponse,
  type QueryIntent,
} from '../services/llm/llmService';
import {
  createConversation,
  getConversation,
  appendMessage,
  mergeMemoryFromQuestion,
  getRecentTurns,
  getMemory,
  updateMemory,
  generateTitle,
  updateConversationTitle,
} from '../services/conversation/conversationService';
import {
  filterChunksByTopic,
  detectManagementTopics,
  isSymptomQuery,
  studyDirectlyInvestigatesSymptom,
  sanitizeSymptomResponse,
  getStudyEvaluatedTopic,
} from '../services/router/topicFilter';
import { reconcileSourcesAndEvidence } from '../services/conversation/citationReconciler';
import {
  detectLanguage,
  normalizeQueryToEnglish,
  translateResponseToTarget,
} from '../services/language/languageService';
import { MetricsCollector } from '../services/evaluation/metricsCollector';
import { recordEvaluation } from '../services/evaluation/evaluationService';
import type { EvaluationRecord } from '../services/evaluation/types';
import type {
  RouteType,
  EvidenceStatus,
  SourceDoc,
  ChatRequest,
  ChatResponse,
  PostHarvestDoc,
  ProfileFact,
  PostHarvestChunk,
  GeneralChunk,
  GeneralEvidencePacket,
} from '../types';

// ── Memory-update response ────────────────────────────────────────────────────
function memoryUpdateResponse(question: string): string {
  const q = question.toLowerCase();
  if (q.includes('gundumalli')) {
    return "Got it — I've noted that you grow Jasminum sambac cv. Gundumalli. I'll use this context for the rest of our conversation.";
  }
  if (q.includes('pacha mullai') || q.includes('auriculatum')) {
    return "Got it — I've noted that you grow Jasminum auriculatum (Pacha Mullai ecotype). I'll use this context throughout our conversation.";
  }
  if (q.includes('sambac') || q.includes('jasmine') || q.includes('jasmin')) {
    return "Understood — I've saved your farm profile information for this conversation.";
  }
  return "I've noted that information and will keep it in mind for this conversation.";
}

// ── Response Formatters for Post-Retrieval Fallbacks ────────────────────────
function insufficientEvidenceResponse(_reason?: string): string {
  return 'The available research does not provide sufficient evidence.';
}

export function formatPostHarvestFallback(
  ragResult: {
    documents: PostHarvestDoc[];
    profile_facts: ProfileFact[];
    chunks?: PostHarvestChunk[];
  },
  query: string,
  targetCultivar?: string,
): string {
  const sections: string[] = [];
  const isSymptom = isSymptomQuery(query);
  const directlyInvestigates = isSymptom && (
    ragResult.documents.some((d) => studyDirectlyInvestigatesSymptom(query, `${d.title} ${d.limitations || ''}`)) ||
    ragResult.profile_facts.some((pf) => studyDirectlyInvestigatesSymptom(query, pf.facts.join(' ')))
  );

  // 1. Direct Answer
  if (isSymptom && !directlyInvestigates) {
    sections.push(
      `### 1. Direct Answer\nThe retrieved research does not directly investigate this symptom. The available studies evaluated post-harvest storage and packaging parameters, and a definitive diagnosis or cause for this symptom cannot be drawn from the retrieved evidence.`
    );
  } else {
    const allFactsText = ragResult.profile_facts.flatMap((pf) => pf.facts).join(' ');
    const practices: string[] = [];
    if (/chitosan/i.test(allFactsText)) {
      practices.push('chitosan-based coating');
    }
    if (/boric\s+acid|polythene/i.test(allFactsText)) {
      practices.push('cold-storage packaging with boric acid and polythene');
    }
    if (/mycelium/i.test(allFactsText)) {
      practices.push('mycelium-foam packaging for transport');
    }
    const speciesLabel = ragResult.documents[0]?.species || 'Jasminum sambac';
    const practicesText = practices.length > 0
      ? `, including ${practices.join(', ')}`
      : '';
    const directAnswer = `The retrieved studies report several post-harvest approaches for maintaining quality and extending the shelf life of ${speciesLabel} flowers${practicesText}. These findings are specific to the experimental conditions reported in the respective studies.`;
    sections.push(`### 1. Direct Answer\n${directAnswer}`);
  }

  // 2. Evidence from Retrieved Studies (or Related Evidence if indirect symptom query)
  sections.push(
    isSymptom && !directlyInvestigates
      ? `### 2. Related Evidence from Retrieved Studies`
      : `### 2. Evidence from Retrieved Studies`
  );

  const renderDoc = (pf: ProfileFact) => {
    const doc = ragResult.documents.find((d) => d.document_id === pf.document_id);
    const title = doc?.title ?? pf.document_id;
    const authorYear = doc?.authors && doc?.year ? ` (${doc.authors}, ${doc.year})` : '';

    const bestFinding = pf.facts.find((f) => f.toLowerCase().includes('best reported') || f.toLowerCase().includes('reported')) ?? pf.facts[0] ?? 'Post-harvest quality and shelf-life evaluation.';

    const condList: string[] = [];
    if (doc?.species) condList.push(`Species: ${doc.species}`);
    if (doc?.cultivar && doc.cultivar !== 'NOT_REPORTED') condList.push(`Cultivar: ${doc.cultivar}`);
    const condFact = pf.facts.find((f) =>
      f.toLowerCase().includes('packaging') ||
      f.toLowerCase().includes('polythene') ||
      f.toLowerCase().includes('boric acid') ||
      f.toLowerCase().includes('temperature') ||
      f.toLowerCase().includes('°c') ||
      f.toLowerCase().includes('box') ||
      f.toLowerCase().includes('foam') ||
      f.toLowerCase().includes('chitosan')
    );
    if (condFact) condList.push(condFact);

    const outcomeFact = pf.facts.find((f) =>
      f.toLowerCase().includes('freshness') ||
      f.toLowerCase().includes('shelf life') ||
      f.toLowerCase().includes('flower opening') ||
      f.toLowerCase().includes('colour retention') ||
      f.toLowerCase().includes('moisture')
    );

    if (isSymptom && !directlyInvestigates) {
      let studyText = `- **Paper Title**: ${title}${authorYear}\n` +
        `- **Key Finding**: The retrieved study evaluated post-harvest storage and packaging conditions, but it did not investigate the cause of this symptom. ${bestFinding}\n` +
        `- **Experimental Conditions**: ${condList.length > 0 ? condList.join('; ') : 'Controlled storage conditions'}`;
      if (outcomeFact) {
        studyText += `\n- **Reported Outcome**: ${outcomeFact}`;
      }
      return studyText;
    }

    let studyText = `- **Paper Title**: ${title}${authorYear}\n` +
      `- **Key Finding**: ${bestFinding}\n` +
      `- **Experimental Conditions**: ${condList.length > 0 ? condList.join('; ') : 'Controlled storage conditions'}`;

    if (outcomeFact) {
      studyText += `\n- **Reported Outcome**: ${outcomeFact}`;
    }

    return studyText;
  };

  if (isSymptom && !directlyInvestigates) {
    sections.push(`#### Related Evidence`);
    for (const pf of ragResult.profile_facts) {
      sections.push(renderDoc(pf));
    }
  } else {
    // Determine the primary cultivar for separating Direct vs Related
    const detectedCultivars = ragResult.documents
      .map((d) => d.cultivar)
      .filter((c) => c && c !== 'NOT_REPORTED');
    const uniqueCultivars = [...new Set(detectedCultivars)];
    const primaryCultivar = targetCultivar || (uniqueCultivars.length >= 1 ? uniqueCultivars[0] : null);
    const hasMultipleCultivars = uniqueCultivars.length >= 2;

    if (primaryCultivar && hasMultipleCultivars) {
      const directFacts = ragResult.profile_facts.filter((pf) => {
        const doc = ragResult.documents.find((d) => d.document_id === pf.document_id);
        const cv = doc?.cultivar;
        return !cv || cv === 'NOT_REPORTED' || cv.toLowerCase() === primaryCultivar.toLowerCase();
      });
      const relatedFacts = ragResult.profile_facts.filter((pf) => !directFacts.includes(pf));

      if (directFacts.length > 0) {
        sections.push(`#### Direct Evidence (${primaryCultivar})`);
        directFacts.forEach((pf) => sections.push(renderDoc(pf)));
      }
      if (relatedFacts.length > 0) {
        sections.push(`#### Related Cultivar Evidence`);
        relatedFacts.forEach((pf) => sections.push(renderDoc(pf)));
      }
    } else if (targetCultivar) {
      const directFacts = ragResult.profile_facts.filter((pf) => {
        const doc = ragResult.documents.find((d) => d.document_id === pf.document_id);
        const text = `${doc?.cultivar || ''} ${doc?.title || ''}`.toLowerCase();
        return text.includes(targetCultivar.toLowerCase());
      });
      const relatedFacts = ragResult.profile_facts.filter((pf) => !directFacts.includes(pf));

      if (directFacts.length > 0) {
        sections.push(`#### Direct Evidence (${targetCultivar})`);
        directFacts.forEach((pf) => sections.push(renderDoc(pf)));
      }
      if (relatedFacts.length > 0) {
        sections.push(`#### Related Cultivar Evidence`);
        relatedFacts.forEach((pf) => sections.push(renderDoc(pf)));
      }
    } else {
      for (const pf of ragResult.profile_facts) {
        sections.push(renderDoc(pf));
      }
    }
  }

  // 3. Research Scope
  sections.push(
    isSymptom && !directlyInvestigates
      ? `### 3. Research Scope\nThese post-harvest findings apply strictly to tested storage and packaging trials and do not establish causal factors for the observed symptom.\n\nNo direct evidence on the cause of this symptom is evaluated in the retrieved research.`
      : `### 3. Research Scope\nThese findings apply strictly to the specific post-harvest treatments, packaging materials, and storage conditions tested in the cited studies.`
  );

  return sections.join('\n\n');
}

export function formatGeneralFallback(
  chunks: GeneralChunk[],
  targetSpecies: string,
  targetCultivar?: string,
  query?: string,
  evidencePackets: GeneralEvidencePacket[] = [],
): string {
  const queryStr = query || '';
  const intent: QueryIntent = queryStr ? detectQueryIntent(queryStr) : 'general';
  const isSymptom = queryStr ? isSymptomQuery(queryStr) : false;
  const directlyInvestigates = isSymptom && queryStr
    ? chunks.some((c) => studyDirectlyInvestigatesSymptom(queryStr, `${c.title || ''} ${c.text || ''}`))
    : false;

  // 1. Symptom queries where studies do not directly investigate the symptom
  if (isSymptom && !directlyInvestigates) {
    const directAnswer = 'The retrieved research does not directly investigate this symptom. The available studies evaluated specific agronomic treatments, and a definitive diagnosis or causal conclusion for this symptom cannot be drawn from the retrieved evidence.';
    const response: GeneralStructuredResponse = {
      query_intent: intent,
      direct_answer: directAnswer,
      research_findings: [],
      farmer_guidance: [],
      factors: [],
      farmer_interpretation: [],
      farmer_actions: [],
      limitations: 'The retrieved studies did not evaluate causes or remedies for this symptom.',
      caution: 'These findings apply specifically to tested agronomic trials and do not establish causal factors for this symptom.',
      supporting_evidence: [],
    };
    return JSON.stringify(response);
  }

  // 2. Domain-specific fallbacks (pest, disease, irrigation, nutrition, pruning)
  const DOMAIN_MATCHERS: Record<string, {
    chunkFilter: (c: GeneralChunk) => boolean;
    defaultFactor: string;
    insufficientMsg: string;
    guidanceTemplate: (factor: string) => string;
  }> = {
    pest: {
      chunkFilter: (c: GeneralChunk) =>
        /\b(?:pest|pests|insect|insects|insecticide|pesticide|bud worm|budworm|thrips|mite|mites|spider mite|whitefly|blossom midge|midge|aphid|aphids|borer|caterpillar|larva|infest)\b/i.test(`${c.title || ''} ${c.text || ''}`),
      defaultFactor: 'Pest management',
      insufficientMsg: 'Insufficient pest-specific evidence was retrieved to provide a reliable management recommendation.',
      guidanceTemplate: (factor: string) => `Farmers managing ${factor.toLowerCase()} should compare the reported findings with local plant protection recommendations.`,
    },
    disease: {
      chunkFilter: (c: GeneralChunk) =>
        /\b(?:disease|diseases|fungus|fungal|fungicide|leaf spot|blight|wilt|pathogen|rot|rust|virus)\b/i.test(`${c.title || ''} ${c.text || ''}`),
      defaultFactor: 'Disease management',
      insufficientMsg: 'Insufficient disease-specific evidence was retrieved to provide a reliable management recommendation.',
      guidanceTemplate: (factor: string) => `Farmers should compare the reported ${factor.toLowerCase()} results with local plant pathology recommendations.`,
    },
    irrigation: {
      chunkFilter: (c: GeneralChunk) =>
        /\b(?:irrigation|drip|water stress|watering|soil moisture|water requirement)\b/i.test(`${c.title || ''} ${c.text || ''}`),
      defaultFactor: 'Irrigation management',
      insufficientMsg: 'Insufficient irrigation-specific evidence was retrieved to provide a reliable management recommendation.',
      guidanceTemplate: (factor: string) => `Farmers should evaluate irrigation scheduling against local soil type and weather conditions.`,
    },
    nutrition: {
      chunkFilter: (c: GeneralChunk) =>
        /\b(?:fertiliz|fertilis|nutrient|nutrition|inm\b|npk\b|fym\b|manure|compost|vermicompost|biofertiliz|micronutrient|micronutrients|panchagavya|fertigation|azospirillum|phosphobacteria|nitrogen|phosphorus|potassium|urea)\b/i.test(`${c.title || ''} ${c.text || ''}`),
      defaultFactor: 'Nutrient management',
      insufficientMsg: 'The retrieved evidence does not provide sufficient nutrient-specific information to reliably explain the effects of nitrogen, phosphorus, potassium, or other nutrient-management practices on growth, flowering, and yield in Jasminum sambac.',
      guidanceTemplate: (factor: string) => `Evaluate nutrient applications against tested cultivar requirements and local soil fertility. Note that nitrogen effects on vegetative growth do not establish flower yield.`,
    },
    pruning: {
      chunkFilter: (c: GeneralChunk) =>
        /\b(?:prun(?:ing|ed|e|es)?|canopy|heading back)\b/i.test(`${c.title || ''} ${c.text || ''}`),
      defaultFactor: 'Pruning',
      insufficientMsg: 'Insufficient pruning-specific evidence was retrieved to provide a reliable recommendation.',
      guidanceTemplate: (factor: string) => `Compare pruning timing and level with local agronomic recommendations rather than treating study schedules as universal.`,
    },
  };

  const domainConfig = DOMAIN_MATCHERS[intent];

  if (domainConfig) {
    const relevantChunks = chunks.filter(domainConfig.chunkFilter);

    if (relevantChunks.length === 0) {
      const response: GeneralStructuredResponse = {
        query_intent: intent,
        direct_answer: domainConfig.insufficientMsg,
        research_findings: [],
        farmer_guidance: [],
        factors: [],
        farmer_interpretation: [],
        farmer_actions: [],
        limitations: `Insufficient ${intent}-specific evidence was retrieved from the current research corpus.`,
        caution: `Consult local agricultural extension or specialist guidelines for field application.`,
        supporting_evidence: [],
      };
      return JSON.stringify(response);
    }

    const findings: GeneralStructuredResponse['research_findings'] = [];
    const guidance: GeneralStructuredResponse['farmer_guidance'] = [];

    // ── Pest fallback: separate occurrence chunks from management-practice chunks ──
    if (intent === 'pest') {
      // Pattern that identifies a chunk as having specific management compound/efficacy data
      const MGMT_COMPOUND_PATTERN = /\b(?:chlorantraniliprole|fenazaquin|thiacloprid|beauveria\s+bassiana|bacillus\s+thuringiensis|lecanicillium|nske|pungam\s+oil|insecticide|acaricide|biorational|spray\s+schedule|intercrop(?:ping)?|marigold)\b/i;
      const MGMT_EFFICACY_PATTERN = /\b(?:per\s+cent\s+reduction|percent\s+reduction|%\s+reduction|reduction\s+over\s+control|efficacy|effective\s+against)\b/i;

      const occurrenceChunks: typeof relevantChunks = [];
      const managementChunks: typeof relevantChunks = [];

      for (const chunk of relevantChunks.slice(0, 6)) {
        const text = `${chunk.title || ''} ${chunk.text}`;
        if (MGMT_COMPOUND_PATTERN.test(text) || MGMT_EFFICACY_PATTERN.test(text)) {
          managementChunks.push(chunk);
        } else {
          occurrenceChunks.push(chunk);
        }
      }

      // Build occurrence finding (always present if any occurrence chunks)
      if (occurrenceChunks.length > 0 || managementChunks.length === 0) {
        const occChunksToUse = occurrenceChunks.length > 0 ? occurrenceChunks : relevantChunks.slice(0, 2);
        const pestNames: string[] = [];
        const occFindingParts: string[] = [];
        for (const chunk of occChunksToUse.slice(0, 3)) {
          const evidence = extractGeneralEvidence(chunk, queryStr);
          const text = evidence.finding && evidence.finding.length > 20 ? evidence.finding : (chunk.text || '').replace(/\s+/g, ' ').slice(0, 180).trim();
          if (!text) continue;
          // Collect pest names
          const pestMatch = text.match(/\b(?:budworm|blossom midge|red spider mite|two-spotted mite|thrips|whitefly|aphid|Hendecasis duplifascialis|Contarinia maculipennis|Tetranychus urticae)\b/gi);
          if (pestMatch) pestNames.push(...pestMatch.map(p => p.trim()));
          occFindingParts.push(text.slice(0, 200));
        }
        const occFinding = occFindingParts.slice(0, 2).join(' ').slice(0, 350).trim() || 'Pest occurrence documented in retrieved studies.';
        const occSourceId = occurrenceChunks[0]?.filename || occurrenceChunks[0]?.title || `Source_occ`;
        findings.push({
          factor: 'Major insect and mite pests',
          finding: occFinding,
          evidence_strength: 'INDIRECT_EVIDENCE',
          source_ids: [occSourceId],
        });
      }

      // Build management finding(s) — only if management chunks exist
      if (managementChunks.length > 0) {
        for (const chunk of managementChunks.slice(0, 2)) {
          const evidence = extractGeneralEvidence(chunk, queryStr);
          const findingText = evidence.finding && evidence.finding.length > 20
            ? evidence.finding
            : (chunk.text || '').replace(/\s+/g, ' ').slice(0, 300).trim();
          if (!findingText) continue;
          const sourceId = chunk.filename || chunk.title || `Source_mgmt`;
          // Detect factor label from chunk title or content
          let mgmtFactor = 'Pest management practices';
          if (/biorational/i.test(`${chunk.title || ''} ${findingText}`)) mgmtFactor = 'Biorational compound management';
          else if (/intercrop|marigold/i.test(`${chunk.title || ''} ${findingText}`)) mgmtFactor = 'Crop diversification (intercropping)';
          findings.push({
            factor: mgmtFactor,
            finding: findingText,
            evidence_strength: evidence.evidence_class === 'DIRECT_EVIDENCE' ? 'DIRECT_EVIDENCE' : 'INDIRECT_EVIDENCE',
            source_ids: [sourceId],
          });
          guidance.push({
            text: `The compounds and methods tested in the cited study offer a study-specific reference point; farmers should consult local pest management specialists or extension services before applying any specific inputs.`,
            source_ids: [sourceId],
          });
        }
      }

      // Guidance for occurrence findings
      if (managementChunks.length === 0) {
        // No management evidence — prescribed text
        guidance.push({
          text: 'Farmers can use the reported pest occurrence information for monitoring and seek locally appropriate integrated pest-management recommendations when these pests are observed.',
          source_ids: findings.map(f => f.source_ids[0]).filter(Boolean),
        });
      } else {
        // Has management evidence — add monitoring guidance too
        guidance.unshift({
          text: 'Use the documented pest occurrence and seasonal incidence data to set up monitoring schedules and identify which pest species to prioritise.',
          source_ids: [occurrenceChunks[0]?.filename || 'occurrence_source'],
        });
      }

      const hasMgmt = managementChunks.length > 0;
      const directAnswer = hasMgmt
        ? `Jasminum sambac is affected by several insect and mite pests; retrieved research also documents specific biorational compounds evaluated for their management under experimental conditions.`
        : `The retrieved evidence identifies the major insect and mite pests of Jasminum sambac and their occurrence, but does not provide sufficient evidence in the retrieved sources to give specific management recommendations.`;

      const response: GeneralStructuredResponse = {
        query_intent: intent,
        direct_answer: directAnswer,
        research_findings: findings,
        farmer_guidance: guidance,
        factors: findings.map(f => ({ factor: f.factor, finding: f.finding, evidence_strength: f.evidence_strength, source_ids: f.source_ids })),
        farmer_interpretation: guidance.map(g => ({ recommendation: g.text, source_ids: g.source_ids })),
        farmer_actions: guidance.map(g => ({ action: g.text, source_ids: g.source_ids })),
        limitations: `These pest findings apply specifically to the species observations and experimental conditions reported in the cited studies.`,
        caution: `Consult local agricultural extension or specialist guidelines for pest management decisions.`,
        supporting_evidence: [],
      };
      return JSON.stringify(response);
    }

    // ── Non-pest fallback: original logic ──────────────────────────────────────
    for (const chunk of relevantChunks.slice(0, 4)) {
      const evidence = extractGeneralEvidence(chunk, queryStr);
      const findingText = evidence.finding && evidence.finding.length > 20
        ? evidence.finding
        : (chunk.text || '').replace(/\s+/g, ' ').slice(0, 200).trim();
      if (!findingText) continue;

      const factorName = domainConfig.defaultFactor;
      const sourceId = chunk.filename || chunk.title || `Source_${findings.length + 1}`;
      findings.push({
        factor: factorName,
        finding: findingText,
        evidence_strength: evidence.evidence_class === 'DIRECT_EVIDENCE' ? 'DIRECT_EVIDENCE' : 'INDIRECT_EVIDENCE',
        source_ids: [sourceId],
      });
      guidance.push({
        text: domainConfig.guidanceTemplate(factorName),
        source_ids: [sourceId],
      });
    }

    const directAnswer = findings.length > 0
      ? `Retrieved research reports observations on jasmine ${intent} practices under the evaluated experimental and field conditions.`
      : domainConfig.insufficientMsg;

    const response: GeneralStructuredResponse = {
      query_intent: intent,
      direct_answer: directAnswer,
      research_findings: findings,
      farmer_guidance: guidance,
      factors: findings.map((f) => ({
        factor: f.factor,
        finding: f.finding,
        evidence_strength: f.evidence_strength,
        source_ids: f.source_ids,
      })),
      farmer_interpretation: guidance.map((g) => ({
        recommendation: g.text,
        source_ids: g.source_ids,
      })),
      farmer_actions: guidance.map((g) => ({
        action: g.text,
        source_ids: g.source_ids,
      })),
      limitations: `These ${intent} findings apply specifically to the tested experimental and survey conditions reported in the cited studies.`,
      caution: `Consult local agricultural extension or specialist guidelines for field application.`,
      supporting_evidence: [],
    };
    return JSON.stringify(response);
  }

  // 3. Flowering / Yield / Mixed / General fallbacks
  const evidenceObjects = chunks
    .map((chunk) => extractGeneralEvidence(chunk, queryStr))
    .filter((evidence) =>
      evidence.evidence_class === 'DIRECT_EVIDENCE' ||
      evidence.evidence_class === 'RELATED_EVIDENCE',
    );
  const usableEvidence = evidenceObjects.filter((evidence) => evidence.evidence_class === 'DIRECT_EVIDENCE');
  const candidateEvidence = usableEvidence.length > 0 ? usableEvidence : evidenceObjects;

  if (candidateEvidence.length === 0) {
    const response: GeneralStructuredResponse = {
      query_intent: intent,
      direct_answer: 'The available research does not provide sufficient evidence.',
      research_findings: [],
      farmer_guidance: [],
      factors: [],
      farmer_interpretation: [],
      farmer_actions: [],
      limitations: 'No direct or related research findings could be extracted from the retrieved passages.',
      caution: 'These findings apply specifically to the tested experimental conditions and cultivars reported in the cited research.',
      supporting_evidence: [],
    };
    return JSON.stringify(response);
  }

  const findings: GeneralStructuredResponse['research_findings'] = [];
  const guidance: GeneralStructuredResponse['farmer_guidance'] = [];

  for (const evidence of candidateEvidence.slice(0, 5)) {
    const chunk = evidence.chunk;
    const sourceId = chunk.filename || chunk.title || `Source_${findings.length + 1}`;
    let findingText = evidence.finding || 'The study evaluated treatments under experimental conditions.';
    let factorName = evidence.topic || 'Agronomic practice';

    if (/\bthiourea\b/i.test(findingText)) {
      factorName = 'Flower-inducing treatments';
      findingText = 'The retrieved study reported increased flowering when 0.5% Thiourea was combined with pruning under the tested conditions. This should be treated as a study-specific finding rather than a universal recommendation.';
      guidance.push({
        text: 'The reported Thiourea treatment can be considered as a study-specific option, subject to locally appropriate agronomic guidance.',
        source_ids: [sourceId],
      });
    } else if (/\bnovember\b/i.test(findingText) && /\bprun/i.test(findingText)) {
      factorName = 'Pruning';
      findingText = 'The retrieved study reported higher flower production for the tested November pruning schedule; farmers should compare this finding with locally appropriate recommendations.';
      guidance.push({
        text: 'Compare the reported pruning schedule with locally appropriate recommendations before applying it.',
        source_ids: [sourceId],
      });
    } else {
      guidance.push({
        text: 'Compare the reported study results with local agronomic recommendations before application.',
        source_ids: [sourceId],
      });
    }

    findings.push({
      factor: factorName,
      finding: findingText,
      evidence_strength: evidence.evidence_class === 'DIRECT_EVIDENCE' ? 'DIRECT_EVIDENCE' : 'INDIRECT_EVIDENCE',
      source_ids: [sourceId],
    });
  }

  const speciesLabel = targetSpecies || 'Jasminum sambac';
  const directAnswer = `${speciesLabel} flower production and growth were linked to the evaluated practices under the reported study conditions.`;

  const response: GeneralStructuredResponse = {
    query_intent: intent,
    direct_answer: directAnswer,
    research_findings: findings,
    farmer_guidance: guidance,
    factors: findings.map((f) => ({
      factor: f.factor,
      finding: f.finding,
      evidence_strength: f.evidence_strength,
      source_ids: f.source_ids,
    })),
    farmer_interpretation: guidance.map((g) => ({
      recommendation: g.text,
      source_ids: g.source_ids,
    })),
    farmer_actions: guidance.map((g) => ({
      action: g.text,
      source_ids: g.source_ids,
    })),
    limitations: 'These findings apply specifically to the tested experimental conditions, field locations, and agronomic management practices reported in the cited research.',
    caution: 'These findings apply specifically to the tested experimental conditions and cultivars reported in the cited research.',
    supporting_evidence: [],
  };

  return JSON.stringify(response);
}

export async function handleChat(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const customQueryId = req.headers && req.headers['x-evaluation-query-id']
    ? String(req.headers['x-evaluation-query-id'])
    : undefined;
  const collector = new MetricsCollector(req.body?.message || '', customQueryId);

  try {
    const diagnosticLogging = process.env.RAG_DEBUG_LLM === '1';
    if (diagnosticLogging) logger.info({ stage: 'ui-query-received' }, 'LLM request flow');
    const { conversationId, message, languagePreference } = req.body as ChatRequest;

    // ── Basic validation ────────────────────────────────────────────────
    if (!conversationId || !message?.trim()) {
      throw Errors.INVALID_REQUEST('conversationId and message are required');
    }
    if (message.length > env.MAX_MESSAGE_LENGTH) {
      throw Errors.INVALID_REQUEST(`Message exceeds maximum length of ${env.MAX_MESSAGE_LENGTH} characters`);
    }

    const cleanMessage = message.trim();

    // ── Language Detection & Normalization ──────────────────────────────
    const { detected: detectedLang, target: targetLang } = detectLanguage(cleanMessage, languagePreference);
    const queryForPipeline = detectedLang === 'kn'
      ? await normalizeQueryToEnglish(cleanMessage, detectedLang)
      : cleanMessage;

    // ── Load conversation state ─────────────────────────────────────────
    const [conv, memory, recentTurns] = await Promise.all([
      getConversation(conversationId),
      getMemory(conversationId),
      getRecentTurns(conversationId, env.MAX_CONTEXT_TURNS),
    ]);

    // ── Resolve follow-up query ─────────────────────────────────────────
    const resolved = resolveFollowup(queryForPipeline, recentTurns, memory);
    const standaloneQuery = resolved.standaloneQuery;

    logger.info(
      {
        conversationId,
        method: resolved.method,
        original: cleanMessage,
        detectedLang,
        targetLang,
        queryForPipeline,
        resolved: standaloneQuery,
      },
      'Query resolved',
    );

    // ── Route question ──────────────────────────────────────────────────
    const route: RouteType = routeQuestion(standaloneQuery, memory);
    logger.info({ conversationId, route }, 'Question routed');

    collector.setCategory(
      route === 'POSTHARVEST'
        ? 'post_harvest'
        : detectQueryIntent(standaloneQuery),
    );
    collector.finishPreprocessing();

    // ── Variables to fill ───────────────────────────────────────────────
    let assistantContent = '';
    let evidenceStatus: EvidenceStatus = 'NOT_APPLICABLE';
    let sources: SourceDoc[] = [];
    let llmCalled = false;
    let selectedDocs: string[] = [];

    // ════════════════════════════════════════════════════════════════════
    // MEMORY_UPDATE — profile statement
    // ════════════════════════════════════════════════════════════════════
    if (route === 'MEMORY_UPDATE') {
      assistantContent = memoryUpdateResponse(cleanMessage);
      evidenceStatus = 'NOT_APPLICABLE';
    }

    // ════════════════════════════════════════════════════════════════════
    // POSTHARVEST — evidence-gated retrieval
    // ════════════════════════════════════════════════════════════════════
    else if (route === 'POSTHARVEST') {
      collector.startRetrieval();
      const ragResult = await retrievePostHarvest(standaloneQuery);
      collector.recordSidecarReceived();
      collector.recordPostHarvestRetrieval(ragResult);
      collector.finishRetrieval();

      evidenceStatus = ragResult.evidence_status;
      selectedDocs = ragResult.selected_docs;

      if (!ragResult.supported) {
        // Evidence gate: LLM must NOT be called
        assistantContent = insufficientEvidenceResponse(ragResult.reason);
        llmCalled = false;
        collector.recordAbstention(ragResult.reason);
        logger.info({ conversationId, reason: ragResult.reason }, 'LLM blocked: INSUFFICIENT_EVIDENCE');
      } else {
        // Build sources
        sources = ragResult.documents.map((d) => ({
          documentId: d.document_id,
          title: d.title,
          authors: d.authors,
          year: d.year,
          doi: d.doi,
        }));

        const targetCultivar = resolved.cultivar || memory.cultivar || undefined;

        // Call LLM (if API key available)
        if (isLlmConfigured()) {
          try {
            const prompt = buildPostHarvestPrompt(
              standaloneQuery,
              ragResult.documents,
              ragResult.profile_facts,
              standaloneQuery,
              ragResult.chunks,
              targetCultivar,
              memory.species || undefined,
            );
            assistantContent = await callLLM(
              prompt,
              undefined,
              undefined,
              undefined,
              (t) => collector.recordLLMTelemetry(t),
            );
            llmCalled = true;
          } catch (llmErr) {
            collector.recordFallback(true);
            logger.warn({ err: llmErr }, 'LLM failed — falling back to formatted profile facts');
            assistantContent = formatPostHarvestFallback(ragResult, standaloneQuery, targetCultivar);
            llmCalled = false;
          }
        } else {
          // No API key — return formatted facts directly
          collector.recordFallback(true);
          assistantContent = formatPostHarvestFallback(ragResult, standaloneQuery, targetCultivar);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // GENERAL_RAG
    // ════════════════════════════════════════════════════════════════════
    else {
      const targetSpecies = resolved.species || memory.species || 'Jasminum sambac';
      const targetCultivar = resolved.cultivar || memory.cultivar || undefined;

      collector.startRetrieval();
      const ragResult = await retrieveGeneral(standaloneQuery, 10, {
        species: targetSpecies,
        cultivar: targetCultivar,
        allowCrossSpecies: false,
      });
      collector.recordSidecarReceived();
      if (diagnosticLogging) logger.info({ stage: 'retrieval-complete' }, 'LLM request flow');

      const tFilterStart = process.hrtime.bigint();

      // ── Hard species-mismatch reclassification ─────────────────────────────
      // The Python sidecar may return chunks from a different jasmine species
      // without setting is_cross_species=true (e.g. if the index mixed metadata).
      // We enforce the active species here regardless of sidecar flags:
      // Any chunk whose `species` field names a recognisably different species
      // than targetSpecies is demoted to the cross-species bucket.
      const JASMINE_SPECIES_ALIASES: Record<string, string> = {
        'sambac': 'Jasminum sambac',
        'jasminum sambac': 'Jasminum sambac',
        'auriculatum': 'Jasminum auriculatum',
        'jasminum auriculatum': 'Jasminum auriculatum',
        'grandiflorum': 'Jasminum grandiflorum',
        'jasminum grandiflorum': 'Jasminum grandiflorum',
        'multiflorum': 'Jasminum multiflorum',
        'jasminum multiflorum': 'Jasminum multiflorum',
      };

      function resolveSpeciesCanonical(raw: string | undefined): string | null {
        if (!raw) return null;
        const lower = raw.toLowerCase().trim();
        // Direct lookup
        if (JASMINE_SPECIES_ALIASES[lower]) return JASMINE_SPECIES_ALIASES[lower];
        // Partial match (e.g. "Jasminum sambac cv. Gundumalli")
        for (const [alias, canonical] of Object.entries(JASMINE_SPECIES_ALIASES)) {
          if (lower.includes(alias)) return canonical;
        }
        return null;
      }

      const activeSpeciesCanonical = resolveSpeciesCanonical(targetSpecies) ?? targetSpecies;

      // Partition sidecar chunks into confirmed-direct and confirmed-cross lists
      const confirmedDirectRaw: typeof ragResult.chunks = [];
      const confirmedCrossRaw: typeof ragResult.chunks = [];

      for (const chunk of ragResult.chunks) {
        const chunkSpecies = resolveSpeciesCanonical(chunk.species);
        const isMismatch =
          chunkSpecies !== null &&
          chunkSpecies.toLowerCase() !== activeSpeciesCanonical.toLowerCase();

        if (chunk.is_cross_species || isMismatch) {
          // Force into cross bucket; annotate if not already annotated
          confirmedCrossRaw.push({
            ...chunk,
            is_cross_species: true,
            cross_species_note:
              chunk.cross_species_note ||
              (isMismatch
                ? `Study species (${chunk.species}) differs from active species (${targetSpecies}).`
                : undefined),
          });
        } else {
          confirmedDirectRaw.push(chunk);
        }
      }

      // Apply Topic-Relevance Filtering: Keep only studies directly evaluating the requested management topic
      const { filteredChunks: directChunks } = filterChunksByTopic(standaloneQuery, confirmedDirectRaw);
      const { filteredChunks: crossChunks } = filterChunksByTopic(standaloneQuery, confirmedCrossRaw);

      const tFilterEnd = process.hrtime.bigint();
      const filteringDurationMs = Number(tFilterEnd - tFilterStart) / 1_000_000;
      collector.finishRetrieval(filteringDurationMs);

      // Preserve the sidecar's one-to-one mapping after topic/species filtering.
      // Unsupported sub-questions remain visible to the answer generator.
      const evidencePackets: GeneralEvidencePacket[] = (ragResult.sub_questions || [{
        id: 'q1',
        question: standaloneQuery,
        evidence_status: 'DIRECT_EVIDENCE',
        evidence_message: '',
        top_score: ragResult.top_score,
        chunks: ragResult.chunks,
      }]).map((packet) => {
        const packetRaw = packet.chunks || [];
        const queryForFilter = detectManagementTopics(packet.question).length > 0
          ? packet.question
          : standaloneQuery;
        const packetDirect = filterChunksByTopic(
          queryForFilter,
          packetRaw.filter((chunk) =>
            !chunk.is_cross_species && chunk.evidence_relation !== 'RELATED_EVIDENCE'),
        ).filteredChunks;
        const packetRelated = filterChunksByTopic(
          queryForFilter,
          packetRaw.filter((chunk) =>
            chunk.is_cross_species || chunk.evidence_relation === 'RELATED_EVIDENCE'),
        ).filteredChunks;
        const packetStatus = packetDirect.length > 0
          ? 'DIRECT_EVIDENCE'
          : packetRelated.length > 0
            ? 'RELATED_EVIDENCE'
            : 'INSUFFICIENT_EVIDENCE';
        return {
          ...packet,
          evidence_status: packetStatus,
          evidence_message: packetStatus === 'INSUFFICIENT_EVIDENCE'
            ? 'The current JasmineGPT knowledge base does not contain sufficient evidence to answer this specific part.'
            : packet.evidence_message,
          chunks: [...packetDirect, ...packetRelated],
        };
      });

      if (evidencePackets.some((packet) => packet.evidence_status === 'DIRECT_EVIDENCE')) {
        evidenceStatus = 'DIRECT_EVIDENCE';
      } else if (evidencePackets.some((packet) => packet.evidence_status === 'RELATED_EVIDENCE')) {
        evidenceStatus = 'SOURCE_REVIEW_REQUIRED';
      } else {
        evidenceStatus = 'INSUFFICIENT_EVIDENCE';
      }

      // Populate real sources matching the evidence status
      if (evidenceStatus === 'DIRECT_EVIDENCE') {
        sources = evidencePackets.flatMap((packet) =>
          packet.chunks.map((chunk) => ({
            chunk,
            evidence: extractGeneralEvidence(chunk, packet.question),
          })),
        )
          .filter(({ evidence }) => evidence.evidence_class === 'DIRECT_EVIDENCE')
          .filter(({ chunk }, index, all) => all.findIndex((item) => item.chunk.filename === chunk.filename) === index)
          .map(({ chunk: c }) => ({
          documentId: c.chunk_id,
          title: c.title || `Source document: ${c.filename}`,
          authors: c.author,
          year: c.year,
          doi: c.doi,
          page: c.page,
          species: c.species,
          category: c.category,
          isCrossSpecies: false,
          crossSpeciesNote: c.cross_species_note,
        }));
      } else if (evidenceStatus === 'SOURCE_REVIEW_REQUIRED') {
        sources = evidencePackets.flatMap((packet) => packet.chunks)
          .filter((chunk, index, all) => all.findIndex((item) => item.filename === chunk.filename) === index)
          .map((c) => ({
          documentId: c.chunk_id,
          title: c.title || c.filename,
          authors: c.author,
          year: c.year,
          doi: c.doi,
          page: c.page,
          species: c.species,
          category: c.category,
          isCrossSpecies: true,
          crossSpeciesNote: c.cross_species_note,
        }));
      } else {
        sources = [];
      }

      const selectedChunks = evidencePackets.flatMap((packet) => packet.chunks);
      const intent = detectQueryIntent(standaloneQuery);
      const { allItems, synthesisItems } = buildRankedSynthesisEvidence(
        selectedChunks,
        intent,
        evidencePackets,
        6,
      );

      collector.recordGeneralRAGRetrieval(
        ragResult,
        directChunks.length,
        crossChunks.length,
        synthesisItems.length,
      );

      if (evidenceStatus === 'INSUFFICIENT_EVIDENCE') {
        collector.recordAbstention('INSUFFICIENT_EVIDENCE');
        if (intent === 'nutrition') {
          const abstention: GeneralStructuredResponse = {
            query_intent: 'nutrition',
            direct_answer:
              'The retrieved evidence does not provide sufficient nutrient-specific information to reliably explain the effects of nitrogen, phosphorus, potassium, or other nutrient-management practices on growth, flowering, and yield in Jasminum sambac.',
            research_findings: [],
            farmer_guidance: [],
            factors: [],
            farmer_interpretation: [],
            farmer_actions: [],
            limitations:
              'The retrieved evidence does not provide sufficient nutrient-specific information for Jasminum sambac.',
            caution:
              'These findings apply specifically to the tested experimental conditions and cultivars reported in the cited research.',
            supporting_evidence: [],
          };
          assistantContent = JSON.stringify(abstention);
        } else {
          assistantContent = evidencePackets
            .map((packet) => `### ${packet.id}: ${packet.question}\n${packet.evidence_message}`)
            .join('\n\n');
        }
        llmCalled = false;
      } else if (isLlmConfigured()) {
        try {
          if (intent === 'nutrition' && synthesisItems.length === 0) {
            collector.recordAbstention('nutrition');
            const abstention: GeneralStructuredResponse = {
              query_intent: 'nutrition',
              direct_answer:
                'The retrieved evidence does not provide sufficient nutrient-specific information to reliably explain the effects of nitrogen, phosphorus, potassium, or other nutrient-management practices on growth, flowering, and yield in Jasminum sambac.',
              research_findings: [],
              farmer_guidance: [],
              factors: [],
              farmer_interpretation: [],
              farmer_actions: [],
              limitations:
                'The retrieved evidence does not provide sufficient nutrient-specific information for Jasminum sambac.',
              caution:
                'These findings apply specifically to the tested experimental conditions and cultivars reported in the cited research.',
              supporting_evidence: [],
            };
            assistantContent = JSON.stringify(abstention);
            llmCalled = false;
          } else {
            if (diagnosticLogging) {
              logger.info({
                stage: 'evidence-prepared',
                evidencePackets: evidencePackets.length,
                retrievedEvidenceCount: selectedChunks.length,
                synthesisEvidenceCount: synthesisItems.length,
                queryIntent: intent,
                evidence: synthesisItems.map((item) => ({
                  evidenceId: item.evidence_id,
                  source: item.source_id,
                  text: item.finding,
                })),
              }, 'LLM request flow');
            }
            const prompt = buildGeneralPrompt(standaloneQuery, selectedChunks, standaloneQuery, targetCultivar, targetSpecies, undefined, synthesisItems);
            const multiQueryPrompt = buildGeneralPrompt(
              standaloneQuery,
              selectedChunks,
              standaloneQuery,
              targetCultivar,
              targetSpecies,
              evidencePackets,
              synthesisItems,
            );
            const structured = await callStructuredGeneralLLM(
              ragResult.is_multi_query ? multiQueryPrompt : prompt,
              buildGeneralEvidenceCoverage(selectedChunks, evidencePackets),
              synthesisItems,
              intent,
              standaloneQuery,
              (t) => collector.recordSynthesisTelemetry(t),
            );
            assistantContent = JSON.stringify(structured);
            llmCalled = true;
            if (diagnosticLogging) {
              logger.info({
                stage: 'parsed-response',
                responseContentEmpty: !assistantContent,
                fallbackUsed: false,
                queryIntent: structured.query_intent,
                retrievedEvidenceCount: selectedChunks.length,
                synthesisEvidenceCount: synthesisItems.length,
                generatedFactorCount: structured.factors.length,
              }, 'LLM request flow');
            }
          }
        } catch (llmErr) {
          collector.recordFallback(true);
          logger.warn({
            stage: 'fallback',
            fallbackUsed: true,
            errorMessage: llmErr instanceof Error ? llmErr.message : 'Unknown LLM error',
          }, 'LLM request flow');
          const fallbackChunks = evidencePackets.flatMap((packet) => packet.chunks);
          assistantContent = formatGeneralFallback(fallbackChunks, targetSpecies, targetCultivar, standaloneQuery, evidencePackets);
          if (diagnosticLogging) {
            logger.info({
              queryIntent: detectQueryIntent(standaloneQuery),
              retrievedEvidenceCount: fallbackChunks.length,
              generatedFactorCount: 0,
              llmStatus: 'FAILED',
              fallbackUsed: true,
              llmOutput: '',
              finalValidatedOutput: assistantContent,
            }, 'RAG DEBUG');
          }
          const gaps = evidencePackets.filter((packet) => packet.evidence_status === 'INSUFFICIENT_EVIDENCE');
          if (gaps.length > 0) {
            try {
              const obj = JSON.parse(assistantContent);
              const gapMsg = gaps.map((packet) => `${packet.question}: ${packet.evidence_message}`).join(' ');
              obj.limitations = obj.limitations ? `${obj.limitations} ${gapMsg}` : gapMsg;
              assistantContent = JSON.stringify(obj);
            } catch {
              assistantContent += `\n\n### Evidence Gaps\n${gaps.map((packet) => `- **${packet.question}**: ${packet.evidence_message}`).join('\n')}`;
            }
          }
        }
      } else {
        // No API key — return structured evidence directly
        collector.recordFallback(true);
        const fallbackChunks = evidencePackets.flatMap((packet) => packet.chunks);
        assistantContent = formatGeneralFallback(fallbackChunks, targetSpecies, targetCultivar, standaloneQuery, evidencePackets);
        const gaps = evidencePackets.filter((packet) => packet.evidence_status === 'INSUFFICIENT_EVIDENCE');
        if (gaps.length > 0) {
          try {
            const obj = JSON.parse(assistantContent);
            const gapMsg = gaps.map((packet) => `${packet.question}: ${packet.evidence_message}`).join(' ');
            obj.limitations = obj.limitations ? `${obj.limitations} ${gapMsg}` : gapMsg;
            assistantContent = JSON.stringify(obj);
          } catch {
            assistantContent += `\n\n### Evidence Gaps\n${gaps.map((packet) => `- **${packet.question}**: ${packet.evidence_message}`).join('\n')}`;
          }
        }
      }
    }

    if (process.env.RAG_DEBUG_SYNTHESIS === '1' && route === 'GENERAL_RAG') {
      logger.info({ finalFarmerAnswer: assistantContent }, 'General RAG final synthesized answer');
    }

    // ── Sanitize Symptom Responses (prevent unauthorized causal inference) ──
    const tPostStart = process.hrtime.bigint();
    assistantContent = sanitizeSymptomResponse(
      assistantContent,
      standaloneQuery,
      sources.map((s) => ({ title: s.title, text: s.category || '' })),
    );

    // ── Enforce 1:1 Evidence-to-Sources Citation Consistency ────────────
    const reconciliation = reconcileSourcesAndEvidence(assistantContent, sources);
    sources = reconciliation.reconciledSources;
    assistantContent = reconciliation.reconciledContent;

    // ── Translate only the final rendered answer (if target is Kannada) ──
    if (targetLang === 'kn') {
      assistantContent = await translateResponseToTarget(assistantContent, 'kn');
    }
    const tPostEnd = process.hrtime.bigint();
    collector.recordPostProcessingLatency(Number(tPostEnd - tPostStart) / 1_000_000);

    // Record deterministic outcome
    collector.recordOutcome(assistantContent, sources, evidenceStatus);
    const evaluationRecord = collector.buildRecord();
    res.locals.evalRecord = evaluationRecord;

    if (process.env.EVAL_LOGGING !== '0') {
      recordEvaluation(evaluationRecord).catch((evalErr) => {
        logger.warn({ err: evalErr }, 'Evaluation log save failed');
      });
    }

    // ── Auto-title the conversation on first turn ───────────────────────
    const msgCount = recentTurns.length;
    if (msgCount === 0 && conv.title === 'New Chat') {
      const title = generateTitle(cleanMessage);
      await updateConversationTitle(conversationId, title);
    }

    // ── Persist messages ────────────────────────────────────────────────
    const [userMsg, assistantMsg] = await Promise.all([
      appendMessage({
        conversationId,
        role: 'user',
        content: cleanMessage,
        route,
        resolvedQuery: standaloneQuery !== cleanMessage ? standaloneQuery : undefined,
      }),
      appendMessage({
        conversationId,
        role: 'assistant',
        content: assistantContent,
        route,
        evidenceStatus,
        sources,
        resolvedQuery: standaloneQuery !== cleanMessage ? standaloneQuery : undefined,
        llmCalled,
      }),
    ]);

    // ── Update memory ───────────────────────────────────────────────────
    await mergeMemoryFromQuestion(conversationId, `${cleanMessage} ${standaloneQuery}`, route, selectedDocs);

    // ── Respond ─────────────────────────────────────────────────────────
    const response: ChatResponse = {
      conversationId,
      userMessageId: String(userMsg._id),
      assistantMessageId: String(assistantMsg._id),
      userMessage: cleanMessage,
      assistantMessage: assistantContent,
      route,
      evidenceStatus,
      llmCalled,
      sources,
      resolvedQuery: standaloneQuery,
      topScore: sources.length > 0 && typeof sources[0].score === 'number' ? sources[0].score : undefined,
      detectedLanguage: detectedLang,
      targetLanguage: targetLang,
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
}

/**
 * Execute an evaluated turn programmatically (for testing and canonical benchmarks).
 */
export async function executeEvaluatedTurn(
  message: string,
  options?: {
    conversationId?: string;
    languagePreference?: 'auto' | 'en' | 'kn';
    queryId?: string;
  },
): Promise<{ response: ChatResponse; evaluationRecord: EvaluationRecord }> {
  let jsonResult: ChatResponse | null = null;

  // Create a real MongoDB conversation so getConversation() can find it by ObjectId
  const evalConv = await createConversation('eval_user', `eval-${options?.queryId || 'query'}`);
  const evalConversationId = String(evalConv._id);

  const mockReq = {
    body: {
      conversationId: options?.conversationId || evalConversationId,
      message,
      languagePreference: options?.languagePreference || 'auto',
    },
    headers: {
      'x-evaluation-query-id': options?.queryId,
    },
  } as unknown as Request;

  const mockRes = {
    locals: {} as Record<string, unknown>,
    json: (data: ChatResponse) => {
      jsonResult = data;
      return mockRes;
    },
  } as unknown as Response;

  let capturedErr: unknown = null;
  await handleChat(mockReq, mockRes, (err?: unknown) => {
    if (err) capturedErr = err;
  });

  if (capturedErr) {
    throw capturedErr;
  }
  if (!jsonResult) {
    throw new Error('No response returned from handleChat');
  }

  const evaluationRecord = mockRes.locals.evalRecord as EvaluationRecord;
  return { response: jsonResult, evaluationRecord };
}
