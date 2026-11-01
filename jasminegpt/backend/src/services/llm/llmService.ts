/**
 * JasmineGPT — LLM Service (OpenRouter)
 * =======================================
 * Calls the LLM ONLY when evidence is supported (DIRECT_EVIDENCE or MULTIPLE_STUDIES).
 * NEVER called for INSUFFICIENT_EVIDENCE.
 *
 * Uses OpenRouter API (OpenAI-compatible endpoint).
 * API key is read from OPENROUTER_API_KEY environment variable — never hard-coded.
 */

import axios, { AxiosError } from 'axios';
import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/errors';
import type {
  PostHarvestDoc,
  GeneralChunk,
  ProfileFact,
  PostHarvestChunk,
  GeneralEvidencePacket,
} from '../../types';
import { isSymptomQuery } from '../router/topicFilter';

export type EvidenceClass =
  | 'DIRECT_EVIDENCE'
  | 'RELATED_EVIDENCE'
  | 'INSUFFICIENT'
  | 'METADATA_ONLY';

type JsonSchema = Record<string, unknown>;

const STRUCTURED_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query_intent: { type: 'string', enum: ['flowering', 'yield', 'mixed', 'disease', 'pest', 'irrigation', 'nutrition', 'pruning', 'general', 'other'] },
    direct_answer: { type: 'string' },
    research_findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factor: { type: 'string' },
          finding: { type: 'string' },
          evidence_strength: { type: 'string', enum: ['DIRECT_EVIDENCE', 'INDIRECT_EVIDENCE', 'INSUFFICIENT_EVIDENCE'] },
          evidence_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['factor', 'finding', 'evidence_ids', 'evidence_strength'],
      },
    },
    farmer_guidance: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'evidence_ids'],
      },
    },
    limitations: { type: 'string' },
  },
  required: ['query_intent', 'direct_answer', 'research_findings', 'farmer_guidance', 'limitations'],
};

export interface GeneralEvidenceObject {
  source_id: string;
  title: string;
  species?: string;
  cultivar?: string;
  topic: string;
  evidence_class: EvidenceClass;
  finding: string;
  conditions: string;
  reported_value: string;
  units: string;
  supports: string[];
  outcome_domain: 'REPRODUCTIVE_OUTPUT' | 'VEGETATIVE_GROWTH' | 'MIXED' | 'UNSPECIFIED';
  supports_reproductive_output: boolean;
  chunk: GeneralChunk;
}

export interface GeneralStructuredResponse {
  query_intent?: QueryIntent;
  direct_answer: string;
  /** New contract: what the research actually reports (📚 Research Findings) */
  research_findings: Array<{
    factor: string;
    finding: string;
    evidence_strength?: EvidenceStrength;
    /** resolved source IDs (filenames) — populated after validation */
    source_ids: string[];
  }>;
  /** New contract: practical interpretation derived ONLY from research findings (🌱 Farmer Guidance) */
  farmer_guidance: Array<{ text: string; source_ids: string[] }>;
  /** @deprecated legacy compat — kept for post-harvest path; populated from farmer_guidance */
  farmer_actions: Array<{ action: string; evidence_ids?: string[]; source_ids: string[] }>;
  /** @deprecated legacy compat */
  farmer_interpretation?: Array<{ recommendation: string; evidence_ids?: string[]; source_ids: string[] }>;
  /** @deprecated use research_findings */
  factors: Array<{
    factor: string;
    finding: string;
    farmer_interpretation?: string;
    evidence_strength?: EvidenceStrength;
    source_ids: string[];
  }>;
  limitations?: string;
  caution: string;
  supporting_evidence: Array<{
    factor: string;
    paper_title: string;
    classification: EvidenceClass;
    key_finding: string;
    experimental_conditions: string;
    source_id: string;
  }>;
}

export type QueryIntent =
  | 'flowering'
  | 'yield'
  | 'mixed'
  | 'disease'
  | 'pest'
  | 'irrigation'
  | 'nutrition'
  | 'pruning'
  | 'general'
  | 'general cultivation'
  | 'other';

export type EvidenceStrength = 'DIRECT_EVIDENCE' | 'INDIRECT_EVIDENCE' | 'INSUFFICIENT_EVIDENCE';

export type GeneralEvidenceCategory =
  | 'Flower-inducing treatments'
  | 'Pruning'
  | 'Plant spacing'
  | 'Growth regulators'
  | 'Nutrient management'
  | 'Nitrogen / vegetative growth'
  | 'Pest management'
  | 'Disease management'
  | 'Irrigation and water management'
  | 'General cultivation';

export interface GeneralEvidenceCoverage {
  category: GeneralEvidenceCategory;
  classification: EvidenceClass;
  finding: string;
  source_ids: string[];
  reproductive_output_supported: boolean;
}

export interface GeneralEvidenceItem {
  evidence_id: string;
  category: GeneralEvidenceCategory;
  source_id: string;
  paper_title: string;
  classification: EvidenceClass;
  finding: string;
  experimental_conditions: string;
  quantitative_result: string;
  outcome_domain: GeneralEvidenceObject['outcome_domain'];
  reproductive_output_supported: boolean;
  year?: number;
}

const PDF_NOISE_PATTERNS = [
  /^(?:int\.?j\.|international journal|original research article|issn\b)/i,
  /\b(?:doi|vol(?:ume)?\.?|issue|pages?|pp\.?)\s*[:.]?\s*[\w./-]+/i,
  /^\s*(?:fig(?:ure)?|table)\s*[A-Z]?\d+(?:\s+[A-Z]\d+)*\s*$/i,
  /^\s*(?:copyright|©|department of|e-?mail|www\.)/i,
];

const RESULT_PATTERNS = [
  /\b(?:recorded|reported|observed|resulted|produced|increased|decreased|higher|lower|maximum|minimum|significant|yielded|found|revealed|was highest|was lowest)\b/i,
  /\b(?:kg\s*(?:\/|per)\s*(?:ha|hectare)|tons?|percent|%|cm|mm|days?|weeks?|months?|ppm|mg|g\s*\/?\s*l)\b/i,
];

const NON_FINDING_PATTERNS = [
  /\b(?:well documented|literatures? relevant|has been reviewed|management important|considered efficient|in recent years)\b/i,
  /^\s*\d+\s+(?:effect|results?|figure|table)\b/i,
];

const VEGETATIVE_OUTCOME_PATTERN =
  /\b(?:plant height|primary shoots?|secondary shoots?|branches?|shoot length|number of leaves|leaf area|vegetative growth|plant vigor|biomass|plant spread)\b/i;
const REPRODUCTIVE_MEASURE_PATTERN =
  /\b(?:flower yield|flower production|yield per plant|yield per hectare|\byield\b|flower buds?|cymes?|flowers per|flower weight|number of flowers|flower initiation|bud initiation|days taken for flowering)\b/i;
const REPRODUCTIVE_RESULT_PATTERN =
  /\b(?:flower yield|flower production|yield per plant|yield per hectare|\byield\b|flower buds?|cymes?|flowers per|flower weight|number of flowers|flower initiation|bud initiation|days taken for flowering)\b[\s\S]{0,120}\b(?:\d+(?:[.,]\d+)?|increased|decreased|higher|lower|maximum|minimum|highest|lowest|superior|significant(?:ly)?|recorded|produced)\b|\b(?:\d+(?:[.,]\d+)?|increased|decreased|higher|lower|maximum|minimum|highest|lowest|superior|significant(?:ly)?|recorded|produced)\b[\s\S]{0,120}\b(?:flower yield|flower production|yield per plant|yield per hectare|\byield\b|flower buds?|cymes?|flowers per|flower weight|number of flowers|flower initiation|bud initiation|days taken for flowering)\b/i;

function cleanEvidenceSentence(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/(?:Int\.?J\.|International Journal)[^.]*\./gi, '')
    .replace(/\b(?:doi|issn)\s*[:.]?\s*\S+/gi, '')
    .replace(/\b(?:fig(?:ure)?|table)\s*[A-Z]?\d+(?:\s+[A-Z]\d+)*\b/gi, '')
    .replace(/^\s*\d+\s+(?=(?:Effect|Results?|Figure|Table)\b)/i, '')
    .replace(/^\W+|\W+$/g, '')
    .trim();
}

function extractCultivar(text: string): string | undefined {
  const match = text.match(
    /\b(?:cv\.?|cultivar)\s*['"]?([A-Za-z][\w -]{2,40})|\bvar\.?\s+([A-Z][A-Za-z-]{2,30})/,
  );
  return (match?.[1] || match?.[2])?.replace(/[.'"]+$/, '').trim();
}

function inferEvidenceTopic(chunk: GeneralChunk): string {
  const text = `${chunk.title || ''} ${chunk.text}`;
  const match = text.match(
    /\b(prun(?:ing|ed|e)|spacing|nitrogen|NPK|organic manure|fertilizer|fertigation|growth regulat(?:or|ing)s? chemicals?|defoliation|irrigation|flower induction|chemical treatment|pest management|insecticide|acaricide|biorational|budworm|blossom midge|spider mite|mite management)\b/i,
  );
  return match?.[1] || chunk.category || 'Other supported factor';
}

export function extractGeneralEvidence(chunk: GeneralChunk, query: string): GeneralEvidenceObject {
  const rawSentences = chunk.text.split(/(?<=[.!?])\s+|\n+/);
  const usableSentences = rawSentences
    .map(cleanEvidenceSentence)
    .filter((sentence) => sentence.length >= 35 && !PDF_NOISE_PATTERNS.some((pattern) => pattern.test(sentence)));
  const resultSentences = usableSentences.filter((sentence) =>
    RESULT_PATTERNS.some((pattern) => pattern.test(sentence)) &&
    !NON_FINDING_PATTERNS.some((pattern) => pattern.test(sentence)),
  );
  const finding = resultSentences
    .slice(0, 2)
    .join(' ')
    .replace(/\b(?:Methods|Materials and Methods)\b[\s\S]*$/i, '')
    .replace(/\b(?:SE\s*\(m\)|CD at 5%|C\.V\.?|Figure\s+\d+|Table\s+\d+)\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
  // Pest-aware: recognise "per cent" text and pest management result patterns
  const hasPestSpecificResult = Boolean(
    finding.match(/\b\d+(?:[.,]\d+)?\s+per\s+cent\b/i) ||
    finding.match(/\b(?:per cent|percent)\s+reduction\b/i) ||
    finding.match(/\b(?:reduction|efficacy|effective(?:ness)?)\b.{0,80}\b(?:per cent|percent|%)\b/i) ||
    finding.match(/\b(?:per cent|percent|%)\b.{0,80}\b(?:reduction|reduction over control|efficacy|control)\b/i) ||
    finding.match(/\b(?:insecticide|acaricide|pesticide|biorational|spray)\b.{0,100}\b(?:effective|significant|recorded|observed)\b/i),
  );
  const hasSpecificResult = Boolean(
    finding.match(/\d+(?:[.,]\d+)?\s*(?:kg|g|mg|cm|mm|ppm|%|days?|weeks?|months?)/i) ||
    hasPestSpecificResult ||
    (finding.match(/\d+(?:[.,]\d+)?/g)?.length || 0) >= 3 &&
      finding.match(/\b(?:flower|yield|bud|prun|spacing|treatment|pest|mite|insect)\b/i) ||
    (/\bprun/i.test(chunk.title || '') &&
      /\b(?:flower|yield)\b/i.test(finding) &&
      /\d/.test(finding)) ||
    finding.match(
      /\b(?:treatment|spacing|pruning|thiourea|defoliation|nitrogen|N[1-9]\b|regulator|micronutrient)\b.{0,140}\b(?:highest|lowest|maximum|minimum|superior|produced|recorded|significant(?:ly)?|increased|reduced|higher|lower)\b/i,
    ) ||
    finding.match(
      /\b(?:highest|lowest|maximum|minimum|superior|produced|recorded|significant(?:ly)?|increased|reduced|higher|lower)\b.{0,140}\b(?:treatment|spacing|pruning|thiourea|defoliation|nitrogen|N[1-9]\b|regulator|micronutrient)\b/i,
    ),
  );
  const metadataOnly = usableSentences.length === 0 ||
    (resultSentences.length === 0 && PDF_NOISE_PATTERNS.some((pattern) => pattern.test(chunk.text)));
  const supportsReproductiveOutput = REPRODUCTIVE_RESULT_PATTERN.test(finding);
  const supportsVegetativeGrowth = VEGETATIVE_OUTCOME_PATTERN.test(finding);
  const outcomeDomain = supportsReproductiveOutput && supportsVegetativeGrowth
    ? 'MIXED'
    : supportsReproductiveOutput
      ? 'REPRODUCTIVE_OUTPUT'
      : supportsVegetativeGrowth
        ? 'VEGETATIVE_GROWTH'
        : 'UNSPECIFIED';
  // Pest evidence is directly related when: query is pest-intent AND finding describes
  // actual pest management compounds/efficacy (not just occurrence/incidence).
  const isPestQuery = /\b(?:pest|insect|mite|management practices?|control|infest)\b/i.test(query);
  const hasPestManagementFinding = /\b(?:chlorantraniliprole|fenazaquin|thiacloprid|beauveria|bacillus|nske|pungam|insecticide|acaricide|biorational|spray|reduction over control|management|intercrop|marigold)\b/i.test(finding);
  const directlyRelated =
    !/\btuberose\b/i.test(finding) &&
    (
      (
        /\b(flower|yield|bud|prun|spacing|nitrogen|nutrition|regulator|treatment|production|cultivat)/i.test(
          `${query} ${finding}`,
        ) &&
        (supportsReproductiveOutput || supportsVegetativeGrowth)
      ) ||
      // Pest management: if the query is pest-intent and the finding describes specific
      // management compounds or efficacy results, treat as directly related
      (isPestQuery && hasPestManagementFinding && hasSpecificResult)
    );
  const evidenceClass: EvidenceClass = metadataOnly
    ? 'METADATA_ONLY'
    : !finding
      ? 'INSUFFICIENT'
      : !hasSpecificResult
        ? 'RELATED_EVIDENCE'
      : directlyRelated
        ? 'DIRECT_EVIDENCE'
        : 'RELATED_EVIDENCE';
  const valueMatch = finding.match(/\b\d+(?:[.,]\d+)?\s*(?:kg\s*\/?\s*(?:ha|hectare)|%|cm|mm|days?|weeks?|months?|ppm|mg|g\s*\/?\s*l)\b/gi);

  return {
    source_id: chunk.filename,
    title: chunk.title || `Source document: ${chunk.filename}`,
    species: chunk.species,
    cultivar: extractCultivar(`${chunk.title || ''} ${chunk.text}`),
    topic: inferEvidenceTopic(chunk),
    evidence_class: evidenceClass,
    finding,
    conditions: [
      chunk.species ? `Species: ${chunk.species}` : '',
      extractCultivar(`${chunk.title || ''} ${chunk.text}`)
        ? `Cultivar: ${extractCultivar(`${chunk.title || ''} ${chunk.text}`)}`
        : '',
      chunk.source ? `Source context: ${chunk.source}` : '',
      chunk.category ? `Category: ${chunk.category}` : '',
    ].filter(Boolean).join('; ') || 'Experimental conditions were not fully present in the retrieved passage.',
    reported_value: valueMatch?.join('; ') || '',
    units: valueMatch?.join('; ') || '',
    supports: finding ? [query] : [],
    outcome_domain: outcomeDomain,
    supports_reproductive_output: supportsReproductiveOutput,
    chunk,
  };
}

export function detectQueryIntent(query: string): QueryIntent {
  const text = query.toLowerCase();

  // 1. Intervention / domain management topics take precedence over general outcome words
  if (/\b(?:disease|diseases|pathogen|pathogens|infection|fungus|fungal|blight|wilt|leaf\s*spot|rot|virus)\b/i.test(text)) return 'disease';
  if (/\b(?:pest|pests|insect|insects|mite|mites|budworm|bud\s*worm|thrips|midge|aphid|aphids|borer|caterpillar)\b/i.test(text)) return 'pest';
  if (/\b(?:irrigation|irrigat(?:e|ed|ing|ion)?|drip|watering|water\s*stress|water\s*requirement|soil\s*moisture)\b/i.test(text)) return 'irrigation';
  if (
    /\b(?:nitrogen|phosphorus|potassium|npk\b|fertiliz(?:er|ers|ation|ised|iser|isers?)?|fertilis(?:er|ers|ation|ised|iser|isers?)?|nutrient|nutrients|nutrition|nutrient-management|nutrient\s+management|nutrient\s+(?:application|dose|treatment|composition|scheduling)|fertiliz(?:er|ation)\s+(?:dose|application|treatment)|fertilis(?:er|ation)\s+(?:dose|application|treatment)|manure|fym\b|micronutrient|micronutrients|foliar\s+(?:nutrition|fertiliz|fertilis|feed)|urea|fertigation|compost|vermicompost|biofertiliz|panchagavya)\b/i.test(
      text,
    )
  )
    return 'nutrition';
  if (/\b(?:prun(?:ing|ed|e|es)?|canopy\s*management|defoliation|heading\s*back)\b/i.test(text)) return 'pruning';

  // 2. Flowering and yield outcome intents (when no specific intervention was specified)
  const hasFlowering = /\bflowering\b|\bflower initiation\b|\bdays? to flower|\bflowering response/.test(text);
  const hasYield = /\byield\b|\bflower weight\b|\bkg\s*\/?\s*(?:ha|hectare)\b|\bper plant\b|\bper plot\b/.test(text);
  if (hasFlowering && hasYield) return 'mixed';
  if (hasFlowering) return 'flowering';
  if (hasYield) return 'yield';
  if (/\bcultivat|\bmanage|\bfarmers?\b/.test(text)) return 'general';
  return 'other';
}

function evidenceRelevance(item: GeneralEvidenceItem, intent: QueryIntent): number {
  const text = `${item.category} ${item.finding} ${item.paper_title || ''} ${item.outcome_domain}`.toLowerCase();
  const flowering = /\bflower(?:ing|s)?\b|\bflower initiation\b|\bdays? to flower|\bflowering response|\bbuds?\b|\bcymes?\b/.test(text);
  const yieldEvidence = /\byield\b|\bproduction\b|\bflower weight\b|\bkg\s*\/?\s*(?:ha|hectare)\b|\bper plant\b|\bper plot\b/.test(text);
  const intentTerms: Record<QueryIntent, RegExp> = {
    flowering: /\bflower(?:ing|s)?\b|\bflower initiation\b|\bdays? to flower|\bflowering response/,
    yield: /\byield\b|\bproduction\b|\bflower weight\b|\bkg\s*\/?\s*(?:ha|hectare)\b|\bper plant\b|\bper plot\b/,
    mixed: /./,
    disease: /\bdisease|pathogen|infection|fung|blight|wilt|leaf spot|rot|virus/,
    pest: /\bpest|insect|mite|bud worm|budworm|thrips|midge|aphid|borer|caterpillar|larva/,
    irrigation: /\birrigat|water|drip/,
    nutrition: /\b(?:fertiliz|fertilis|nutrient|nutrition|inm\b|npk\b|fym\b|manure|compost|vermicompost|biofertiliz|micronutrient|micronutrients|panchagavya|fertigation|azospirillum|phosphobacteria|nitrogen|phosphorus|potassium|urea)\b/i,
    pruning: /\bprun/,
    general: /./,
    'general cultivation': /./,
    other: /./,
  };
  let score = intentTerms[intent].test(text) ? 100 : 0;
  if (intent === 'pest') {
    if (intentTerms.pest.test(text)) score += 60;
    else score -= 80;
  } else if (intent === 'disease') {
    if (intentTerms.disease.test(text)) score += 60;
    else score -= 80;
  } else if (intent === 'irrigation') {
    if (intentTerms.irrigation.test(text)) score += 60;
    else score -= 80;
  } else if (intent === 'nutrition') {
    if (intentTerms.nutrition.test(text)) score += 60;
    else score -= 120;
  } else if (intent === 'pruning') {
    if (intentTerms.pruning.test(text)) score += 60;
    else score -= 80;
  } else if (intent === 'flowering') {
    if (flowering) score += 50;
    if (yieldEvidence && !flowering) score -= 25;
  } else if (intent === 'yield') {
    if (yieldEvidence) score += 50;
    if (flowering && !yieldEvidence) score -= 25;
  } else if (intent === 'mixed') {
    score += flowering ? 30 : 0;
    score += yieldEvidence ? 30 : 0;
  }
  if (item.classification === 'DIRECT_EVIDENCE') score += 20;
  return score;
}

function cleanJsonCandidate(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  const match = cleaned.match(/\{[\s\S]*/);
  if (!match) return cleaned;
  let jsonString = match[0];
  const lastBrace = jsonString.lastIndexOf('}');
  if (lastBrace !== -1) {
    jsonString = jsonString.slice(0, lastBrace + 1);
  }
  return jsonString;
}

function repairJson(jsonStr: string): string {
  let str = jsonStr.trim();
  // Strip trailing commas before closing braces/brackets
  str = str.replace(/,\s*([}\]])/g, '$1');
  let inString = false;
  let quoteEscaped = false;
  const stack: string[] = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (quoteEscaped) {
      quoteEscaped = false;
      continue;
    }
    if (char === '\\') {
      quoteEscaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (char === ']' && stack[stack.length - 1] === '[') stack.pop();
    }
  }

  if (inString) str += '"';
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') str += '}';
    else if (open === '[') str += ']';
  }
  return str.replace(/,\s*([}\]])/g, '$1');
}

function parseRawEvidenceIds(item: Record<string, unknown>): string[] {
  let ids: string[] = [];
  if (Array.isArray(item.evidence_ids)) {
    ids = (item.evidence_ids as unknown[]).filter((id): id is string => typeof id === 'string');
  } else if (typeof item.evidence_ids === 'string') {
    ids = [item.evidence_ids];
  } else if (typeof item.evidence_id === 'string') {
    ids = [item.evidence_id];
  } else if (Array.isArray(item.source_ids)) {
    ids = (item.source_ids as unknown[]).filter((id): id is string => typeof id === 'string');
  }
  return ids.length > 0 ? ids : ['E1'];
}

function parseStructuredResponse(raw: string): GeneralStructuredResponse | null {
  const jsonCandidate = cleanJsonCandidate(raw);
  const match = jsonCandidate.match(/\{[\s\S]*/);
  if (!match) return null;
  let jsonString = match[0];
  const lastBrace = jsonString.lastIndexOf('}');
  if (lastBrace !== -1) {
    jsonString = jsonString.slice(0, lastBrace + 1);
  } else {
    jsonString = repairJson(jsonString);
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(jsonString) as Record<string, unknown>;
  } catch {
    try {
      parsed = JSON.parse(repairJson(jsonString)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;

  try {
    const validIntents: QueryIntent[] = [
      'flowering', 'yield', 'mixed', 'disease', 'pest', 'irrigation',
      'nutrition', 'pruning', 'general', 'general cultivation', 'other',
    ];
    const rawIntent = typeof parsed.query_intent === 'string' ? parsed.query_intent.trim().toLowerCase() : '';
    const queryIntent: QueryIntent = validIntents.includes(rawIntent as QueryIntent)
      ? (rawIntent as QueryIntent)
      : 'mixed';

    const directAnswer = typeof parsed.direct_answer === 'string'
      ? parsed.direct_answer.trim()
      : typeof parsed.answer === 'string'
        ? parsed.answer.trim()
        : typeof parsed.summary === 'string'
          ? parsed.summary.trim()
          : '';
    if (!directAnswer) return null;

    // ── Parse research_findings (new contract with flexible aliases) ────────
    const findingsSource = Array.isArray(parsed.research_findings)
      ? parsed.research_findings
      : Array.isArray(parsed.findings)
        ? parsed.findings
        : Array.isArray(parsed.factors)
          ? parsed.factors
          : Array.isArray(parsed.key_findings)
            ? parsed.key_findings
            : [];

    const rawFindings = (findingsSource as unknown[])
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => {
        const factor = typeof item.factor === 'string'
          ? item.factor.trim()
          : typeof item.topic === 'string'
            ? item.topic.trim()
            : typeof item.title === 'string'
              ? item.title.trim()
              : typeof item.name === 'string'
                ? item.name.trim()
                : 'Reported finding';
        const finding = typeof item.finding === 'string'
          ? item.finding.trim()
          : typeof item.description === 'string'
            ? item.description.trim()
            : typeof item.text === 'string'
              ? item.text.trim()
              : typeof item.result === 'string'
                ? item.result.trim()
                : '';
        return {
          factor,
          finding,
          evidence_strength: (item.evidence_strength as EvidenceStrength) || 'DIRECT_EVIDENCE',
          evidence_ids: parseRawEvidenceIds(item),
        };
      })
      .filter((item) => item.finding.length > 0)
      .slice(0, 6);

    // If findings array was empty but direct answer exists, synthesize a fallback finding
    if (rawFindings.length === 0) {
      rawFindings.push({
        factor: 'Reported findings',
        finding: directAnswer,
        evidence_strength: 'DIRECT_EVIDENCE',
        evidence_ids: ['E1'],
      });
    }

    // ── Parse farmer_guidance (new contract with flexible aliases) ──────────
    const guidanceSource = Array.isArray(parsed.farmer_guidance)
      ? parsed.farmer_guidance
      : Array.isArray(parsed.guidance)
        ? parsed.guidance
        : Array.isArray(parsed.farmer_interpretation)
          ? parsed.farmer_interpretation
          : Array.isArray(parsed.recommendations)
            ? parsed.recommendations
            : [];

    const rawGuidance: Array<{ text: string; evidence_ids: string[]; source_ids: string[] }> = [];
    for (const item of guidanceSource as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const g = item as Record<string, unknown>;
      const text = typeof g.text === 'string'
        ? g.text.trim()
        : typeof g.recommendation === 'string'
          ? g.recommendation.trim()
          : typeof g.guidance === 'string'
            ? g.guidance.trim()
            : typeof g.action === 'string'
              ? g.action.trim()
              : '';
      if (!text) continue;
      const ids = parseRawEvidenceIds(g);
      rawGuidance.push({ text, evidence_ids: ids, source_ids: ids });
    }

    if (rawGuidance.length === 0 && rawFindings.length > 0) {
      rawGuidance.push({
        text: 'Farmers should compare the reported findings with local agronomic recommendations before application.',
        evidence_ids: rawFindings[0].evidence_ids,
        source_ids: rawFindings[0].evidence_ids,
      });
    }

    // ── Legacy farmer_actions fallback ─────────────────────────────
    const rawActions: Array<{ action: string; evidence_ids: string[]; source_ids: string[] }> = [];
    if (Array.isArray(parsed.farmer_actions)) {
      for (const item of parsed.farmer_actions as unknown[]) {
        if (
          item !== null && typeof item === 'object' &&
          typeof (item as Record<string, unknown>).action === 'string'
        ) {
          const ids = Array.isArray((item as Record<string, unknown>).evidence_ids)
            ? (item as Record<string, unknown>).evidence_ids as string[]
            : [];
          rawActions.push({ action: (item as Record<string, unknown>).action as string, evidence_ids: ids, source_ids: ids });
        }
      }
    }

    const caution = typeof parsed.caution === 'string' ? parsed.caution.trim() :
      typeof parsed.limitations === 'string' ? parsed.limitations.trim() : '';
    const limitations = typeof parsed.limitations === 'string' ? parsed.limitations.trim() :
      typeof parsed.caution === 'string' ? parsed.caution.trim() : '';

    return {
      query_intent: queryIntent,
      direct_answer: directAnswer,
      // New contract fields
      research_findings: rawFindings.map((item) => ({
        factor: item.factor,
        finding: item.finding,
        evidence_strength: item.evidence_strength,
        source_ids: item.evidence_ids,
      })),
      farmer_guidance: rawGuidance.map((item) => ({
        text: item.text,
        source_ids: item.evidence_ids,
      })),
      // Legacy compat fields (populated from new fields)
      factors: rawFindings.map((item) => ({
        factor: item.factor,
        finding: item.finding,
        evidence_strength: item.evidence_strength,
        source_ids: item.evidence_ids,
      })),
      farmer_interpretation: rawGuidance.map((item) => ({
        recommendation: item.text,
        evidence_ids: item.evidence_ids,
        source_ids: item.source_ids,
      })),
      farmer_actions: rawActions.length > 0 ? rawActions : rawGuidance.map((item) => ({
        action: item.text,
        evidence_ids: item.evidence_ids,
        source_ids: item.source_ids,
      })),
      caution,
      limitations,
      supporting_evidence: [],
    };
  } catch {
    return null;
  }
}

function normalizeFactorLabel(value: string): GeneralEvidenceCategory | undefined {
  if (/flower.?inducing|thiourea|nitrobenzene|flower induction/i.test(value)) return 'Flower-inducing treatments';
  if (/prun/i.test(value)) return 'Pruning';
  if (/spacing/i.test(value)) return 'Plant spacing';
  if (/growth regulator|GA3|CCC|regulator/i.test(value)) return 'Growth regulators';
  if (/nitrogen/i.test(value)) return 'Nitrogen / vegetative growth';
  if (/nutrition|NPK|organic manure|fertilizer|manure/i.test(value)) return 'Nutrient management';
  if (/\b(?:pest|insect|mite|bud worm|budworm|thrips|whitefly|blossom midge|midge|aphid|borer|caterpillar)\b/i.test(value)) return 'Pest management';
  if (/\b(?:disease|fungus|fungal|fungicide|leaf spot|blight|wilt|pathogen|rot|rust)\b/i.test(value)) return 'Disease management';
  if (/\b(?:irrigation|drip|water stress|watering|soil moisture)\b/i.test(value)) return 'Irrigation and water management';
  if (/\b(?:cultivat|growth|harvest|propagation|management)\b/i.test(value)) return 'General cultivation';
  return undefined;
}

function categoriesForEvidence(value: string): GeneralEvidenceCategory[] {
  const categories: GeneralEvidenceCategory[] = [];
  if (/flower.?inducing|thiourea|nitrobenzene|flower induction/i.test(value)) categories.push('Flower-inducing treatments');
  if (/\bprun/i.test(value)) categories.push('Pruning');
  if (/spacing/i.test(value)) categories.push('Plant spacing');
  if (/growth regulator|GA3|CCC|regulator/i.test(value)) categories.push('Growth regulators');
  if (/\bnitrogen\b/i.test(value)) categories.push('Nitrogen / vegetative growth');
  if (/\bNPK|manure|fertilizer|nutrition|vermicompost\b/i.test(value)) categories.push('Nutrient management');
  if (/\b(?:pest|pests|insect|insects|insecticide|pesticide|bud worm|budworm|thrips|mite|mites|spider mite|whitefly|blossom midge|midge|aphid|aphids|borer|caterpillar|parasitoid|ipm)\b/i.test(value)) {
    categories.push('Pest management');
  }
  if (/\b(?:disease|diseases|fungus|fungal|fungicide|leaf spot|blight|wilt|pathogen|rot|rust|virus)\b/i.test(value)) {
    categories.push('Disease management');
  }
  if (/\b(?:irrigation|drip|water stress|watering|soil moisture)\b/i.test(value)) {
    categories.push('Irrigation and water management');
  }
  if (categories.length === 0 && /\b(?:cultivat|growth|harvest|propagation|cuttings|nursery|management)\b/i.test(value)) {
    categories.push('General cultivation');
  }
  return categories;
}

export function buildGeneralEvidenceCoverage(
  chunks: GeneralChunk[],
  evidencePackets?: GeneralEvidencePacket[],
): GeneralEvidenceCoverage[] {
  const packets = evidencePackets || [{
    id: 'q1',
    question: '',
    evidence_status: chunks.length ? 'DIRECT_EVIDENCE' as const : 'INSUFFICIENT_EVIDENCE' as const,
    evidence_message: '',
    top_score: 0,
    chunks,
  }];
  const byCategory = new Map<GeneralEvidenceCategory, GeneralEvidenceObject[]>();
  for (const packet of packets) {
    for (const chunk of packet.chunks) {
      const evidence = extractGeneralEvidence(chunk, packet.question);
      const categories = categoriesForEvidence(`${evidence.topic} ${evidence.finding} ${chunk.title || ''}`);
      for (const category of categories) {
        const entries = byCategory.get(category) || [];
        entries.push(evidence);
        byCategory.set(category, entries);
      }
    }
  }
  const categories: GeneralEvidenceCategory[] = [
    'Flower-inducing treatments',
    'Pruning',
    'Plant spacing',
    'Growth regulators',
    'Nutrient management',
    'Nitrogen / vegetative growth',
    'Pest management',
    'Disease management',
    'Irrigation and water management',
    'General cultivation',
  ];
  return categories.map((category) => {
    const entries = byCategory.get(category) || [];
    const direct = entries.filter((entry) => entry.evidence_class === 'DIRECT_EVIDENCE');
    const usable = direct.length > 0 ? direct : entries.filter((entry) => entry.evidence_class === 'RELATED_EVIDENCE');
    const first = usable[0];
    return {
      category,
      classification: first?.evidence_class || 'INSUFFICIENT',
      finding: first?.finding || 'No usable finding was retrieved for this category.',
      source_ids: [...new Set(usable.map((entry) => entry.source_id))],
      reproductive_output_supported: usable.some((entry) => entry.supports_reproductive_output),
    };
  });
}

function actionIsUnsafe(action: string): boolean {
  return /^\s*(?:apply|use|implement|utili[sz]e|spray|adopt|maintain|follow)\b/i.test(action) ||
    /\b(?:should|must|ideal|best|optimal|maximi[sz]e(?:s|d)? yield)\b/i.test(action);
}

function containsNitrogenYieldClaim(text: string): boolean {
  return /\bnitrogen\b[\s\S]{0,100}\b(?:increases?|improves?|enhances?|boosts?|raises?)\b[\s\S]{0,100}\b(?:flower|yield|production)\b/i.test(text) ||
    /\b(?:flower|yield|production)\b[\s\S]{0,100}\b(?:increases?|improves?|enhances?|boosts?|raises?)\b[\s\S]{0,100}\bnitrogen\b/i.test(text);
}

function mentionsNitrogenOrNutrition(text: string): boolean {
  if (!text) return false;
  const textWithoutThiourea = text.replace(/\bthiourea\b/gi, '');
  return /\b(?:nitrogen|nutrient|nutrition|fertilizer|npk|manure|urea|fertigation)\b/i.test(textWithoutThiourea);
}

function makeSafeAction(category: GeneralEvidenceCategory, finding: string): string {
  if (category === 'Nitrogen / vegetative growth') {
    return 'Evaluate nitrogen management for vegetative growth only; the retrieved passage does not establish a direct flower-yield effect.';
  }
  if (category === 'Plant spacing') {
    return 'Evaluate spacing for the relevant cultivar and local conditions; the reported spacing result is study-specific.';
  }
  if (category === 'Pruning') {
    if (/\bnovember\b/i.test(finding)) {
      return 'The retrieved study reported higher flower production for the tested November pruning schedule; farmers should compare this finding with locally appropriate recommendations.';
    }
    return 'Compare pruning timing and level with local recommendations because the retrieved studies reported differences in flower production.';
  }
  if (category === 'Growth regulators') {
    return 'Consider reported growth-regulator results only as study-specific options and seek appropriate local agronomic guidance before use.';
  }
  if (category === 'Nutrient management') {
    return 'Evaluate nutrient management, including the reported NPK/organic-manure treatment, against local recommendations and cultivar conditions.';
  }
  if (category === 'Flower-inducing treatments') {
    if (/\bthiourea\b/i.test(finding)) {
      return 'The retrieved study reported increased flowering when 0.5% Thiourea was combined with pruning under the tested conditions. This should be treated as a study-specific finding rather than a universal recommendation.';
    }
    return 'Consider the reported flower-inducing treatment only as a study-specific option and seek appropriate local agronomic guidance before application.';
  }
  if (category === 'Pest management') {
    return 'Compare the reported pest control observations with local plant protection recommendations before application.';
  }
  if (category === 'Disease management') {
    return 'Consult local plant pathology recommendations before applying the disease management practices reported in this study.';
  }
  if (category === 'Irrigation and water management') {
    return 'Evaluate the reported irrigation schedule against local soil and weather conditions.';
  }
  return 'Consider this as a study-specific finding and compare it with local agronomic recommendations.';
}

const RAW_TEXT_PATTERNS = [
  /treatments?\s+flowers\s+per\s+plant/i,
  /factor\s+[a-z]\s+-\s+time\s+of\s+prun/i,
  /se\s*\(m\)|cd\s+at\s+5%|c\.v\.?/i,
  /baramasi treatments/i,
  /\b(?:table|figure)\s*\d+\b.*flowers\s+per/i,
];

function containsRawText(text: string): boolean {
  return RAW_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function containsFilename(text: string): boolean {
  return /\b\w{4,60}\.pdf\b/i.test(text);
}

function sanitizeFarmerInterpretation(text: string): string {
  // Rewrite risky prescriptive patterns into study-scoped language.
  return text
    .replace(/^\s*Farmers?\s+should\s+(?:consider\s+)?(apply|use|adopt|implement|spray|follow|plant|prune)\b/i,
      'Farmers can compare')
    .replace(/^\s*Farmers?\s+should\b/i,
      'Farmers can evaluate whether to')
    .replace(/^\s*Farmers?\s+may\s+(apply|use|adopt|implement|prune|plant)\b/i,
      'Farmers can evaluate')
    .replace(/^\s*(Apply|Use|Adopt|Implement|Spray|Always|Increase|Prune|Plant)\s+/i,
      'The retrieved study suggests considering ')
    .replace(/\b(must|should)\s+(apply|use|adopt|implement|prune|plant)\b/gi,
      'may evaluate')
    .replace(/\b(?:optimal|best|always|universally)\b/gi, 'reported');
}

function sanitizeStudySpecificWording(text: string): string {
  let cleaned = text.trim();

  // Change 2: Study-specific Thiourea wording
  if (/\bthiourea\b/i.test(cleaned)) {
    if (
      /\b(?:should|must|can\s+enhance|can\s+improve|can\s+increase|recommend|recommended)\b/i.test(cleaned) ||
      /^\s*(?:apply|use|spray|implement)\b/i.test(cleaned) ||
      /\b(?:by\s+applying|along\s+with\s+pruning)\b/i.test(cleaned) ||
      !/\bstudy-specific\b/i.test(cleaned)
    ) {
      return 'The retrieved study reported increased flowering when 0.5% Thiourea was combined with pruning under the tested conditions. This should be treated as a study-specific finding rather than a universal recommendation.';
    }
  }

  // Change 3: Study-specific November pruning wording
  if (/\bnovember\b/i.test(cleaned) && /\bprun(?:ing|e)?\b/i.test(cleaned)) {
    if (
      /\b(?:should|must|can\s+enhance|can\s+improve|can\s+increase|maximize|maximi[sz]e|recommend|recommended)\b/i.test(cleaned) ||
      /^\s*(?:prune|cut)\b/i.test(cleaned) ||
      /farmers?\s+(?:should|can|may)\s+(?:consider\s+)?pruning/i.test(cleaned) ||
      !/\blocally\s+appropriate\b/i.test(cleaned)
    ) {
      return 'The retrieved study reported higher flower production for the tested November pruning schedule; farmers should compare this finding with locally appropriate recommendations.';
    }
  }

  return sanitizeFarmerInterpretation(cleaned);
}

export function validateAndRepairStructuredResponse(
  response: GeneralStructuredResponse,
  coverage: GeneralEvidenceCoverage[],
  evidenceItems: GeneralEvidenceItem[] = [],
  queryIntent: QueryIntent = response.query_intent || 'mixed',
  queryText = '',
): {
  response: GeneralStructuredResponse;
  missingCategories: GeneralEvidenceCategory[];
  invalidEvidenceIds: string[];
  mergedFactors: string[];
  irrelevantFactors: string[];
} {
  // ── Build ID lookup maps ────────────────────────────────────────────────────
  // The LLM uses compact E1..E6 IDs; resolve them to real source filenames.
  const evidenceMap = new Map(evidenceItems.map((item) => [item.evidence_id, item]));
  const sourceMap = new Map(evidenceItems.map((item) => [item.source_id, item]));

  const resolveIds = (ids: string[]): string[] => [...new Set(ids.flatMap((id) => {
    const item = evidenceMap.get(id);
    return item ? [item.source_id] : (sourceMap.has(id) ? [id] : []);
  }))];

  // Collect all IDs emitted across research_findings, farmer_guidance, and legacy fields
  const researchFindingIds = (response.research_findings || []).flatMap((item) => item.source_ids);
  const farmerGuidanceIds = (response.farmer_guidance || []).flatMap((item) => item.source_ids);
  const farmerInterpIds = (response.farmer_interpretation || []).flatMap((item) => item.source_ids || item.evidence_ids || []);
  const allEvidenceIds = [
    ...researchFindingIds,
    ...farmerGuidanceIds,
    ...response.factors.flatMap((item) => item.source_ids),
    ...response.farmer_actions.flatMap((item) => item.source_ids),
    ...farmerInterpIds,
  ];
  // Invalid = IDs the model generated that don't exist in our evidence map
  const invalidEvidenceIds = [...new Set(allEvidenceIds.filter((id) => !evidenceMap.has(id) && !sourceMap.has(id)))];

  // ── Resolve research_findings IDs to filenames ─────────────────────────────
  const resolvedFindings = (response.research_findings || response.factors || []).map((item) => ({
    ...item,
    source_ids: resolveIds(item.source_ids),
  }));

  // ── Resolve farmer_guidance IDs to filenames ──────────────────────────────
  const resolvedGuidance = (response.farmer_guidance || []).map((item) => ({
    ...item,
    source_ids: resolveIds(item.source_ids),
  }));

  // ── Resolve legacy fields ──────────────────────────────────────────────────
  const resolvedFactors = response.factors.map((item) => ({
    ...item,
    source_ids: resolveIds(item.source_ids),
  }));
  const resolvedActions = response.farmer_actions.map((item) => ({
    ...item,
    source_ids: resolveIds(item.source_ids),
  }));
  const resolvedInterpretations = (response.farmer_interpretation || []).map((item) => ({
    ...item,
    source_ids: resolveIds(item.evidence_ids || item.source_ids || []),
  }));

  // ── Direct Answer study-specific sanitization ──────────────────────────────
  let directAnswer = response.direct_answer;
  if (directAnswer) {
    if (/\bthiourea\b/i.test(directAnswer) && /\b(?:should|must|can\s+enhance|apply)\b/i.test(directAnswer)) {
      directAnswer = directAnswer
        .replace(/farmers?\s+(?:should\s+(?:apply|use)|can\s+enhance\s+flowering\s+by\s+applying)\s+0?\.?5%?\s*thiourea(?:\s+along\s+with\s+pruning)?/gi,
          'the retrieved study reported increased flowering when 0.5% Thiourea was combined with pruning under tested conditions')
        .replace(/apply\s+0?\.?5%?\s*thiourea/gi,
          'the reported combination of 0.5% Thiourea with pruning');
    }
    if (/\bnovember\b/i.test(directAnswer) && /\b(?:should|must|maximize)\b/i.test(directAnswer)) {
      directAnswer = directAnswer
        .replace(/farmers?\s+should\s+(?:consider\s+)?pruning\s+in\s+the\s+last\s+week\s+of\s+november(?:\s+to\s+maximize\s+flower\s+yield)?/gi,
          'the tested November pruning schedule was associated with higher flower production in the retrieved study');
    }
  }

  // ── Sanitize research_findings ─────────────────────────────────────────────
  const cleanedFindings = resolvedFindings.map((item) => {
    let finding = item.finding;
    if (containsRawText(finding)) {
      finding = 'The retrieved passage could not be cleanly synthesized; see supporting evidence for details.';
    } else if (containsFilename(finding)) {
      finding = finding.replace(/\b\w{4,60}\.pdf\b/gi, '').replace(/\s{2,}/g, ' ').trim();
    }
    // Nitrogen safety on research findings
    if (normalizeFactorLabel(item.factor) === 'Nitrogen / vegetative growth' && containsNitrogenYieldClaim(finding)) {
      finding = 'The retrieved evidence reports effects of nitrogen on vegetative growth, but it does not establish a direct increase in flower yield.';
    }
    // Repair unsafe prescriptive language in research findings
    if (/\bthiourea\b/i.test(finding) && (/\b(?:should|must|can\s+enhance|apply|maximi[sz]e(?:s|d)?)\b/i.test(finding) || !/\bstudy-specific\b/i.test(finding))) {
      finding = 'The retrieved study reported increased flowering when 0.5% Thiourea was combined with pruning under the tested conditions. This should be treated as a study-specific finding rather than a universal recommendation.';
    } else if (/\bnovember\b/i.test(finding) && (/\b(?:should|must|maximi[sz]e(?:s|d)?|farmers?\s+should)\b/i.test(finding) || !/\blocally\s+appropriate\b/i.test(finding))) {
      finding = 'The retrieved study reported higher flower production for the tested November pruning schedule; farmers should compare this finding with locally appropriate recommendations.';
    } else {
      const category = normalizeFactorLabel(`${item.factor} ${finding}`);
      if (category && actionIsUnsafe(finding)) {
        finding = finding.replace(/^\s*(?:apply|use|implement|utili[sz]e)\s+/i, 'The study reported ');
      }
    }
    return { ...item, finding };
  });

  // ── Sanitize farmer_guidance ──────────────────────────────────────────────
  // Step A: Remove guidance items that have no valid (resolved) evidence IDs
  const cleanedGuidancePreFilter = resolvedGuidance
    .filter((item) => item.source_ids.length > 0)
    .map((item) => ({
      ...item,
      text: sanitizeStudySpecificWording(item.text),
    }));

  // Step B: Remove guidance items whose text is identical/near-identical to a research finding
  const findingTexts = cleanedFindings.map((f) =>
    f.finding.toLowerCase().replace(/[^a-z0-9]/g, ''),
  );
  const cleanedGuidance = cleanedGuidancePreFilter.filter((item) => {
    const guidanceNorm = item.text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !findingTexts.some(
      (ft) => ft === guidanceNorm || ft.includes(guidanceNorm) || guidanceNorm.includes(ft),
    );
  });

  // ── Sanitize legacy fields ─────────────────────────────────────────────────
  const cleanedFactors = resolvedFactors.map((factor) => {
    let finding = factor.finding;
    if (containsRawText(finding)) {
      finding = 'The retrieved passage could not be cleanly synthesized; see supporting evidence for details.';
    } else if (containsFilename(finding)) {
      finding = finding.replace(/\b\w{4,60}\.pdf\b/gi, '').replace(/\s{2,}/g, ' ').trim();
    }
    const interp = factor.farmer_interpretation
      ? sanitizeStudySpecificWording(factor.farmer_interpretation)
      : factor.farmer_interpretation;
    return { ...factor, finding, farmer_interpretation: interp };
  });
  const cleanedInterpretations = resolvedInterpretations.map((item) => ({
    ...item,
    recommendation: sanitizeStudySpecificWording(item.recommendation),
  }));
  const cleanedActions = resolvedActions.map((item) => {
    const category = normalizeFactorLabel(item.action);
    return actionIsUnsafe(item.action) || /\b(?:thiourea|november)\b/i.test(item.action)
      ? { ...item, action: category ? makeSafeAction(category, item.action) : sanitizeStudySpecificWording(item.action) }
      : { ...item, action: sanitizeStudySpecificWording(item.action) };
  });

  // ── Nitrogen safety on legacy factors ────────────────────────────────────
  const groundedFactors = cleanedFactors.map((factor) =>
    normalizeFactorLabel(factor.factor) === 'Nitrogen / vegetative growth' && containsNitrogenYieldClaim(factor.finding)
      ? {
        ...factor,
        finding: 'The retrieved evidence reports effects of nitrogen on vegetative growth, but it does not establish a direct increase in flower yield.',
      }
      : factor,
  );
  const repairedFactors = groundedFactors.map((factor) => {
    let finding = factor.finding;
    const category = normalizeFactorLabel(`${factor.factor} ${finding}`);
    if (/\bthiourea\b/i.test(finding) && (/\b(?:should|must|can\s+enhance|apply|maximi[sz]e(?:s|d)?)\b/i.test(finding) || !/\bstudy-specific\b/i.test(finding))) {
      finding = 'The retrieved study reported increased flowering when 0.5% Thiourea was combined with pruning under the tested conditions. This should be treated as a study-specific finding rather than a universal recommendation.';
    } else if (/\bnovember\b/i.test(finding) && (/\b(?:should|must|maximi[sz]e(?:s|d)?|farmers?\s+should)\b/i.test(finding) || !/\blocally\s+appropriate\b/i.test(finding))) {
      finding = 'The retrieved study reported higher flower production for the tested November pruning schedule; farmers should compare this finding with locally appropriate recommendations.';
    } else if (category && actionIsUnsafe(finding)) {
      finding = finding.replace(/^\s*(?:apply|use|implement|utili[sz]e)\s+/i, 'The study reported ');
    }
    return { ...factor, finding };
  });

  // ── Missing category detection ─────────────────────────────────────────────
  const relevantCategories = new Set(
    evidenceItems
      .filter((item) => evidenceRelevance(item, queryIntent) >= 70)
      .map((item) => item.category),
  );
  const directCategories = coverage.filter((item) =>
    item.classification === 'DIRECT_EVIDENCE' &&
    item.category !== 'Nitrogen / vegetative growth' &&
    relevantCategories.has(item.category),
  );
  const generatedCategories = repairedFactors
    .map((item) => normalizeFactorLabel(`${item.factor} ${item.finding}`))
    .filter((category): category is GeneralEvidenceCategory => Boolean(category));
  const missingCategories = directCategories
    .filter((item) => !generatedCategories.includes(item.category))
    .map((item) => item.category);

  // ── Merged factor detection ────────────────────────────────────────────────
  const mergedFactors = repairedFactors
    .filter((item) => categoriesForEvidence(item.factor).length > 1)
    .map((item) => item.factor);

  // ── Irrelevant factor detection ────────────────────────────────────────────
  const irrelevantFactors = repairedFactors
    .filter((item) => {
      const ids = item.source_ids.map((id) => sourceMap.get(id) || evidenceMap.get(id)).filter(Boolean) as GeneralEvidenceItem[];
      return ids.length > 0 && ids.every((evidence) => evidenceRelevance(evidence, queryIntent) < 70);
    })
    .map((item) => item.factor);

  const fallbackGuidanceItems = repairedFactors.map((factor) => ({
    text: makeSafeAction(normalizeFactorLabel(factor.factor) || 'Flower-inducing treatments', factor.finding),
    source_ids: factor.source_ids,
  }));
  const fallbackInterpretations = repairedFactors.map((factor) => ({
    recommendation: makeSafeAction(normalizeFactorLabel(factor.factor) || 'Flower-inducing treatments', factor.finding),
    source_ids: factor.source_ids,
  }));

  // ── Change 1: Nitrogen relevance check ─────────────────────────────────────
  const nitrogenInQuery = queryIntent === 'nutrition' || mentionsNitrogenOrNutrition(queryText);
  const nitrogenInFindings = cleanedFindings.some((f) =>
    normalizeFactorLabel(f.factor) === 'Nitrogen / vegetative growth' ||
    normalizeFactorLabel(f.factor) === 'Nutrient management' ||
    mentionsNitrogenOrNutrition(`${f.factor} ${f.finding}`)
  );
  const nitrogenInFactors = repairedFactors.some((f) =>
    normalizeFactorLabel(f.factor) === 'Nitrogen / vegetative growth' ||
    normalizeFactorLabel(f.factor) === 'Nutrient management' ||
    mentionsNitrogenOrNutrition(`${f.factor} ${f.finding} ${f.farmer_interpretation || ''}`)
  );
  const nitrogenInGuidance = cleanedGuidance.some((g) => mentionsNitrogenOrNutrition(g.text));
  const nitrogenInRecommendations =
    cleanedInterpretations.some((i) => mentionsNitrogenOrNutrition(i.recommendation)) ||
    cleanedActions.some((a) => mentionsNitrogenOrNutrition(a.action)) ||
    nitrogenInGuidance ||
    fallbackInterpretations.some((f) => mentionsNitrogenOrNutrition(f.recommendation));

  const nitrogenIsRelevant = nitrogenInQuery || nitrogenInFindings || nitrogenInFactors || nitrogenInRecommendations;

  let finalLimitations = response.limitations || response.caution || 'These findings apply specifically to the tested experimental conditions and cultivars reported in the cited research.';
  let finalCaution = response.caution || response.limitations || 'These findings apply specifically to the tested experimental conditions and cultivars reported in the cited research.';

  if (!nitrogenIsRelevant) {
    const stripNitrogenWarning = (text: string): string => {
      if (!/\bnitrogen\b/i.test(text)) return text;
      const sentences = text
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !/\bnitrogen\b/i.test(sentence));
      const result = sentences.join(' ').trim();
      return result || 'These findings apply specifically to the tested experimental conditions and cultivars reported in the cited research.';
    };
    finalLimitations = stripNitrogenWarning(finalLimitations);
    finalCaution = stripNitrogenWarning(finalCaution);
  }

  // ── Nutrient-management evidence guard ────────────────────────────────────
  // When query is a nutrition query, deterministically validate that every
  // research_finding and farmer_guidance item is backed by actual nutrient evidence.
  // This prevents pruning/Thiourea/plant-density/irrigation chunks from being
  // presented as nutrient-management answers even if the LLM included them.
  let finalDirectAnswer = directAnswer;
  let finalCleanedFindings = cleanedFindings;
  let finalCleanedGuidance = cleanedGuidance;
  let finalRepairedFactors = repairedFactors;
  let finalCleanedActions = cleanedActions;
  let finalCleanedInterpretations = cleanedInterpretations;
  let finalFallbackGuidance = fallbackGuidanceItems;
  let finalFallbackInterpretations = fallbackInterpretations;

  if (queryIntent === 'nutrition') {
    // Filter findings to only those whose factor label or finding text contains nutrient keywords
    const NUTRIENT_FINDING_PATTERN = /\b(?:fertiliz(?:er|ers|ation|iser|ized|izer|izers?)?|nutrient|nutrients|nutrition|inm\b|npk\b|fym\b|manure|compost|vermicompost|biofertiliz|micronutrient|micronutrients|panchagavya|fertigation|azospirillum|phosphobacteria|organic\s+manure|nitrogen|phosphorus|potassium|zinc\s+sulphate|borax|farmyard\s+manure|nutrient\s+(?:management|dose|application|treatment|composition)|fertilizer\s+(?:dose|treatment|application)|npk\s+(?:ratio|treatment|application|dose)|foliar\s+(?:nutrition|feed|fertiliz)|soil\s+fertility|macro\s*nutrient|micro\s*nutrient|nutrient\s+uptake|rdf\b)/i;
    const isNutrientFinding = (factor: string, finding: string): boolean =>
      NUTRIENT_FINDING_PATTERN.test(`${factor} ${finding}`);

    finalCleanedFindings = cleanedFindings.filter((f) => isNutrientFinding(f.factor, f.finding));
    finalRepairedFactors = repairedFactors.filter((f) => isNutrientFinding(f.factor, f.finding));
    finalCleanedActions = cleanedActions.filter((a) => isNutrientFinding('', a.action));
    finalCleanedInterpretations = cleanedInterpretations.filter((i) => isNutrientFinding('', i.recommendation));
    finalFallbackGuidance = fallbackGuidanceItems.filter((g) => isNutrientFinding('', g.text));
    finalFallbackInterpretations = fallbackInterpretations.filter((f) => isNutrientFinding('', f.recommendation));

    // Sync guidance to surviving findings
    const survivingSourceIds = new Set(finalCleanedFindings.flatMap((f) => f.source_ids));
    finalCleanedGuidance = cleanedGuidance.filter(
      (g) => g.source_ids.some((id) => survivingSourceIds.has(id)) && isNutrientFinding('', g.text),
    );
    finalFallbackGuidance = finalFallbackGuidance.filter(
      (g) => g.source_ids.some((id) => survivingSourceIds.has(id)),
    );

    // If no nutrient-specific findings survive, replace with evidence-grounded abstention
    if (finalCleanedFindings.length === 0 && finalRepairedFactors.length === 0) {
      finalDirectAnswer =
        'The retrieved evidence does not provide sufficient nutrient-specific information to reliably explain the effects of nitrogen, phosphorus, potassium, or other nutrient-management practices on growth, flowering, and yield in Jasminum sambac.';
      finalCleanedGuidance = [];
      finalFallbackGuidance = [];
      finalFallbackInterpretations = [];
      finalCleanedInterpretations = [];
      finalCleanedActions = [];
    }
  }

  // Final farmer_guidance: use sanitized guidance if non-empty, else generate from findings
  const finalGuidance = finalCleanedGuidance.length > 0 ? finalCleanedGuidance : finalFallbackGuidance;

  const groundedResponse: GeneralStructuredResponse = {
    ...response,
    direct_answer: finalDirectAnswer,
    // New contract fields
    research_findings: finalCleanedFindings.map((f) => ({
      factor: f.factor,
      finding: f.finding,
      evidence_strength: f.evidence_strength || 'DIRECT_EVIDENCE',
      source_ids: f.source_ids,
    })),
    farmer_guidance: finalGuidance,
    // Legacy compat fields
    factors: finalRepairedFactors.map((f) => ({
      ...f,
      evidence_strength: f.evidence_strength || 'DIRECT_EVIDENCE',
    })),
    farmer_interpretation: finalCleanedInterpretations.length > 0 ? finalCleanedInterpretations : finalFallbackInterpretations,
    farmer_actions: finalCleanedActions.length > 0 ? finalCleanedActions : finalFallbackInterpretations.map((item) => ({
      action: item.recommendation,
      source_ids: item.source_ids,
    })),
    limitations: finalLimitations,
    caution: finalCaution,
  };

  return {
    response: groundedResponse,
    missingCategories,
    invalidEvidenceIds,
    mergedFactors,
    irrelevantFactors,
  };
}

/**
 * Nutrient-management evidence pattern: used to validate that a chunk/finding
 * actually contains nutrient-specific content before using it for synthesis.
 * Applied deterministically — no LLM call.
 */
export const NUTRIENT_EVIDENCE_PATTERN =
  /\b(?:fertiliz(?:er|ers|ation|iser|ised|ize|ized|izer|izers|ation|ising|izing|ant|ants)?|nutrient|nutrients|nutrition|inm\b|npk\b|fym\b|manure|compost|vermicompost|biofertiliz|bio-fertiliz|micronutrient|micronutrients|panchagavya|humic acid|fertigation|foliar\s+(?:nutrition|feed|fertiliz|fertiliser|spray\s+of\s+(?:npk|zinc|boron|iron|urea|micronutrient))|azospirillum|phosphobacteria|potassium\s+solubiliz|organic\s+manure|nitrogen\s+(?:application|dose|treatment|level|management)|phosphorus\s+(?:application|dose|treatment|level|management)|potassium\s+(?:application|dose|treatment|level|management)|zinc\s+sulphate|borax|ferrous\s+sulphate|cow\s+dung|farmyard\s+manure|nutrient\s+(?:scheduling|management|dose|application|treatment|composition)|fertilizer\s+(?:dose|treatment|application)|npk\s+(?:ratio|treatment|application|dose)|\bN\s*:\s*P\s*:\s*K\b|\bP\b.*\bK\b.*\bN\b|\bRDF\b|recommended\s+dose\s+of\s+fertilizer|foliar\s+nutrition|nutrient\s+uptake|soil\s+fertility|macro\s*nutrient|micro\s*nutrient)\b/i;

/**
 * Nutrient-management query detection: deterministic keyword matching.
 * Returns true if the query explicitly asks about nutrient/fertilizer management.
 */
export function isNutrientManagementQuery(query: string): boolean {
  return /\b(?:nitrogen|phosphorus|potassium|npk|fertiliz(?:er|ers|ation|iser|izers?)|fertiliser|nutrient|nutrients|nutrient.management|nutrient.application|fertiliz(?:er|iser)\s+(?:dose|application)|manure|micronutrient|micronutrients|foliar\s+(?:nutrition|fertiliz|fertiliser|nutrient)|nutrient\s+(?:treatment|dose|composition)|fertigation|inm\b|fym\b)\b/i.test(query);
}

/**
 * Validates that a retrieved chunk/finding actually contains nutrient-specific evidence.
 * Used to prevent pruning/PGR/spacing/post-harvest chunks from being used as
 * nutrient evidence when the query is about nutrient management.
 *
 * Returns true if the chunk's title+text contain nutrient-specific keywords.
 * Returns false for pruning-only, Thiourea-only, plant-density-only,
 * irrigation-only, or generic cultivation evidence.
 */
export function chunkContainsNutrientEvidence(chunk: { title?: string; text?: string }): boolean {
  const haystack = `${chunk.title || ''} ${chunk.text || ''}`;
  return NUTRIENT_EVIDENCE_PATTERN.test(haystack);
}

/**
 * Compact synthesis system prompt — kept short to reduce input token cost.
 * Instructs the LLM to produce clearly separated Research Findings and Farmer Guidance
 * within the SINGLE OpenRouter call.
 */
const SYNTHESIS_SYSTEM_PROMPT =
  'You are synthesizing Jasminum sambac agricultural research evidence.\n' +
  'Answer ONLY from the supplied evidence items (E1–E6).\n' +
  'Rules:\n' +
  '1. Use only E1–E6 as evidence_ids. Never use filenames or arbitrary IDs.\n' +
  '2. Match query_intent to the supplied QUERY_INTENT value exactly.\n' +
  '3. research_findings: each item is one distinct practice/factor with a unique label (e.g. "Pruning", "Flower-inducing treatment", "Plant spacing").\n' +
  '   - State ONLY what the retrieved evidence reports. Do not add general agricultural knowledge.\n' +
  '   - Keep experimental findings study-specific. Do not convert a single study result into a universal claim.\n' +
  '   - Every research_findings item MUST have valid evidence_ids.\n' +
  '4. farmer_guidance: each item is a DISTINCT practical interpretation derived ONLY from the research_findings.\n' +
  '   - Do NOT copy or repeat the research finding text in farmer_guidance.\n' +
  '   - Do NOT independently answer the question. Do NOT introduce facts absent from the retrieved evidence.\n' +
  '   - Use cautious wording when evidence is experimental or study-specific.\n' +
  '   - Every farmer_guidance item MUST have valid evidence_ids.\n' +
  '   - For Thiourea: "The reported Thiourea treatment can be considered as a study-specific option, subject to locally appropriate agronomic guidance."\n' +
  '   - For November pruning: "Compare the reported pruning schedule with locally appropriate recommendations before applying it."\n' +
  '   - Never prescribe universal actions like "Farmers should apply...", "Use Thiourea", or "Prune in November to maximize yield."\n' +
  '5. If a treatment combines two practices (e.g. Thiourea + pruning), label it "Flower-inducing treatment" not "Pruning".\n' +
  '6. Findings must be synthesized natural language — never copy table headers, raw PDF text, or metadata.\n' +
  '7. If nitrogen or nutrient management is discussed: note that nitrogen evidence showing only vegetative growth does NOT establish flower yield. Do NOT include this nitrogen limitation if nitrogen is not discussed.\n' +
  '8. Do not include source filenames inside research_findings or farmer_guidance.\n' +
  '9. Return valid JSON only — no prose outside the JSON object.\n' +
  '10. Be concise: direct_answer 2–3 sentences, each finding 1–2 sentences, each guidance item 1 sentence.\n' +
  '11. For PEST queries ONLY — you MUST separate two types of pest evidence into distinct research_findings:\n' +
  '    a) Pest occurrence: label "Major insect and mite pests" or individual pest names. Describe which pests were recorded and their seasonal patterns.\n' +
  '       Set evidence_strength to the Evidence type from the evidence block (DIRECT_EVIDENCE or INDIRECT_EVIDENCE — never upgrade INDIRECT to DIRECT).\n' +
  '    b) Pest management: if any evidence block discusses specific compounds (e.g. Chlorantraniliprole, Fenazaquin, Beauveria bassiana, NSKE, intercropping)\n' +
  '       with documented efficacy (e.g. percent reduction over control), create a SEPARATE research_finding for each management approach.\n' +
  '       Label it "Biorational management" or "Crop diversification" etc. Describe the compound/method and the documented reduction percentage.\n' +
  '       Set evidence_strength to DIRECT_EVIDENCE for these management findings.\n' +
  '    c) If NO evidence block contains specific management compounds or efficacy data, do NOT invent any.\n' +
  '       Instead, the direct_answer MUST include: "The retrieved evidence identifies these major pests and their occurrence, but does not provide sufficient evidence in the retrieved sources to give specific management recommendations."\n' +
  '       The single farmer_guidance item MUST be: "Farmers can use the reported pest occurrence information for monitoring and seek locally appropriate integrated pest-management recommendations when these pests are observed."\n' +
  '12. For NUTRITION queries ONLY — strict nutrient-management evidence rules:\n' +
  '    a) Only include evidence blocks that explicitly contain fertilizer/nutrient/NPK/manure/nitrogen/phosphorus/potassium information.\n' +
  '    b) Do NOT use pruning-only, Thiourea-only, plant-density-only, irrigation-only, or generic cultivation evidence as nutrient evidence.\n' +
  '    c) If the retrieved evidence does NOT contain explicit nutrient/fertilizer content, do NOT synthesize nutrient findings. Instead set:\n' +
  '       direct_answer: "The retrieved evidence does not provide sufficient nutrient-specific information to reliably explain the effects of nitrogen, phosphorus, potassium, or other nutrient-management practices on growth, flowering, and yield in Jasminum sambac."\n' +
  '       research_findings: []\n' +
  '       farmer_guidance: []\n' +
  '    d) Never present pruning, Thiourea, plant spacing, or irrigation findings as answers to a nutrient-management question.';

/**
 * JSON schema instruction appended to the user prompt.
 * New contract: research_findings + farmer_guidance (replaces factors + farmer_interpretation).
 */
const SCHEMA_INSTRUCTION =
  'Return ONLY valid JSON matching exactly:\n' +
  '{"query_intent":"flowering|yield|mixed|disease|pest|irrigation|nutrition|pruning|general|other",' +
  '"direct_answer":"2-3 sentences",' +
  '"research_findings":[{"factor":"exact label","finding":"1-2 sentences stating what the study reports","evidence_ids":["E1"],"evidence_strength":"DIRECT_EVIDENCE|INDIRECT_EVIDENCE|INSUFFICIENT_EVIDENCE"}],' +
  '"farmer_guidance":[{"text":"1 sentence practical interpretation derived ONLY from research_findings — do NOT copy the finding","evidence_ids":["E1"]}],' +
  '"limitations":"1 sentence"}';

export async function callStructuredGeneralLLM(
  prompt: string,
  coverage: GeneralEvidenceCoverage[] = [],
  evidenceItems: GeneralEvidenceItem[] = [],
  queryIntent: QueryIntent = detectQueryIntent(prompt),
  queryText = '',
  onTelemetry?: (t: SynthesisExecutionTelemetry) => void,
): Promise<GeneralStructuredResponse> {
  // ── Token budget ──────────────────────────────────────────────────────────
  const maxPromptTokens = Number(process.env.RAG_SYNTHESIS_MAX_PROMPT_TOKENS || 2500);
  // Output budget: 800 tokens ensures complete JSON generation without premature truncation
  const maxOutputTokens = Number(process.env.RAG_SYNTHESIS_MAX_OUTPUT_TOKENS || 800);
  const userPrompt = `${prompt}\n\n${SCHEMA_INSTRUCTION}`;
  const promptTokenEstimate = Math.ceil((SYNTHESIS_SYSTEM_PROMPT.length + userPrompt.length) / 4);

  if (promptTokenEstimate > maxPromptTokens) {
    logger.error({
      promptTokenEstimate,
      maxPromptTokens,
      provider: 'OpenRouter',
      model: env.OPENROUTER_MODEL,
    }, 'PROMPT TOO LARGE FOR SYNTHESIS — falling back');
    throw new Error('PROMPT TOO LARGE FOR SYNTHESIS');
  }

  // ── Cost/debug logging ────────────────────────────────────────────────────
  if (process.env.RAG_DEBUG_LLM === '1') {
    logger.info({
      QUERY_INTENT: queryIntent,
      RETRIEVED_EVIDENCE_COUNT: evidenceItems.length,
      SYNTHESIS_EVIDENCE_COUNT: Math.min(evidenceItems.length, 6),
      PROMPT_TOKEN_ESTIMATE: promptTokenEstimate,
      MAX_OUTPUT_TOKENS: maxOutputTokens,
      PROVIDER: 'OpenRouter',
      MODEL: env.OPENROUTER_MODEL,
      LLM_CALLS: 1,
    }, 'SYNTHESIS BUDGET');
  }

  // ── ONE LLM call ──────────────────────────────────────────────────────────
  let capturedLlmTelemetry: LLMCallTelemetry | null = null;
  const rawResponse = await callLLM(
    userPrompt,
    SYNTHESIS_SYSTEM_PROMPT,
    maxOutputTokens,
    STRUCTURED_RESPONSE_SCHEMA,
    (t) => { capturedLlmTelemetry = t; },
  );

  const tParseStart = process.hrtime.bigint();
  const parsed = parseStructuredResponse(rawResponse);
  const tParseEnd = process.hrtime.bigint();
  const parsingLatencyMs = Math.round(Number(tParseEnd - tParseStart) / 10_000) / 100;

  if (process.env.RAG_DEBUG_LLM === '1') {
    logger.info({
      HTTP_STATUS: 200,
      LLM_STATUS: parsed ? 'SUCCESS' : 'PARSE_FAILED',
      FALLBACK_USED: !parsed,
      JSON_VALID: Boolean(parsed),
    }, 'LLM RESULT');
  }

  if (parsed) {
    // ── Deterministic validation + repair (NO second LLM call) ────────────
    const tValStart = process.hrtime.bigint();
    const validated = validateAndRepairStructuredResponse(parsed, coverage, evidenceItems, queryIntent, queryText || prompt);
    const tValEnd = process.hrtime.bigint();
    const validationLatencyMs = Math.round(Number(tValEnd - tValStart) / 10_000) / 100;

    if (onTelemetry && capturedLlmTelemetry) {
      onTelemetry({
        llm: capturedLlmTelemetry,
        parsingLatencyMs,
        validationLatencyMs,
        validJson: true,
        validationPassed: true,
      });
    }

    if (process.env.RAG_DEBUG_LLM === '1') {
      logger.info({
        GENERATED_FACTOR_COUNT: validated.response.factors.length,
        MISSING_CATEGORIES: validated.missingCategories,
        INVALID_EVIDENCE_IDS: validated.invalidEvidenceIds,
        MERGED_FACTORS: validated.mergedFactors,
        IRRELEVANT_FACTORS: validated.irrelevantFactors,
      }, 'VALIDATION RESULT');
    }

    // Always return the deterministically repaired response — never call LLM again.
    return validated.response;
  }

  if (onTelemetry && capturedLlmTelemetry) {
    onTelemetry({
      llm: capturedLlmTelemetry,
      parsingLatencyMs,
      validationLatencyMs: 0,
      validJson: false,
      validationPassed: false,
    });
  }

  // ── Parse failed: throw so the caller's fallback handler fires ────────────
  // This avoids a second LLM call. The fallback (formatGeneralFallback) handles it.
  throw new Error('LLM returned unparseable JSON — using deterministic fallback');
}

export function extractGeneralEvidencePackets(
  packets: GeneralEvidencePacket[],
): GeneralEvidenceObject[] {
  return packets.flatMap((packet) =>
    packet.chunks.map((chunk) => extractGeneralEvidence(chunk, packet.question)),
  );
}

/**
 * Compact evidence block for the LLM context.
 * Uses short temporary IDs (E1..E6) — filenames are intentionally excluded.
 * The backend resolves IDs back to real sources after validation.
 */
function buildCompactEvidenceBlock(item: GeneralEvidenceItem, id: string): string {
  const lines: string[] = [
    id,
    `Source title: ${item.paper_title.slice(0, 70)}`,
    `Evidence type: ${item.classification === 'DIRECT_EVIDENCE' ? 'DIRECT_EVIDENCE' : 'INDIRECT_EVIDENCE'}`,
  ];
  const finding = item.finding.replace(/\s+/g, ' ').trim().slice(0, 180);
  if (finding) lines.push(`Relevant finding: "${finding}"`);
  const quant = item.quantitative_result.replace(/\s+/g, ' ').trim().slice(0, 70);
  if (quant && quant !== 'Not stated') lines.push(`Key numbers: ${quant}`);
  return lines.join('\n');
}

export function buildRankedSynthesisEvidence(
  chunks: GeneralChunk[],
  queryOrIntent: string | QueryIntent,
  evidencePackets?: GeneralEvidencePacket[],
  maxEvidence = 6,
): { allItems: GeneralEvidenceItem[]; synthesisItems: GeneralEvidenceItem[] } {
  const validIntents: QueryIntent[] = [
    'flowering', 'yield', 'mixed', 'disease', 'pest', 'irrigation',
    'nutrition', 'pruning', 'general', 'general cultivation', 'other',
  ];
  const intent = validIntents.includes(queryOrIntent as QueryIntent)
    ? (queryOrIntent as QueryIntent)
    : detectQueryIntent(queryOrIntent);

  let allItems = buildGeneralEvidenceItems(chunks, evidencePackets)
    .sort((a, b) => evidenceRelevance(b, intent) - evidenceRelevance(a, intent));

  if (intent === 'nutrition') {
    const NUTRIENT_ITEM_PATTERN = /\b(?:fertiliz|fertilis|nutrient|nutrition|inm\b|npk\b|fym\b|manure|compost|vermicompost|biofertiliz|micronutrient|micronutrients|panchagavya|fertigation|azospirillum|phosphobacteria|organic\s+manure|nitrogen|phosphorus|potassium|zinc\s+sulphate|borax|farmyard\s+manure|nutrient\s+(?:management|dose|application|treatment|composition)|fertilizer\s+(?:dose|treatment|application)|npk\s+(?:ratio|treatment|application|dose)|foliar\s+(?:nutrition|feed|fertiliz)|soil\s+fertility|macro\s*nutrient|micro\s*nutrient|nutrient\s+uptake|rdf\b)/i;
    allItems = allItems.filter((item) =>
      NUTRIENT_ITEM_PATTERN.test(`${item.category} ${item.finding} ${item.paper_title || ''} ${item.experimental_conditions || ''}`),
    );
  }

  const synthesisItems = allItems.slice(0, maxEvidence).map((item, index) => ({
    ...item,
    evidence_id: `E${index + 1}`,
  }));

  return { allItems, synthesisItems };
}

function buildCompactGeneralPrompt(
  query: string,
  chunks: GeneralChunk[],
  targetSpecies?: string,
  targetCultivar?: string,
  evidencePackets?: GeneralEvidencePacket[],
  customSynthesisItems?: GeneralEvidenceItem[],
): string {
  const intent = detectQueryIntent(query);
  const MAX_SYNTHESIS_EVIDENCE = Number(process.env.RAG_SYNTHESIS_MAX_EVIDENCE || 6);

  const { allItems, synthesisItems: rankedSynthesis } = buildRankedSynthesisEvidence(
    chunks,
    intent,
    evidencePackets,
    MAX_SYNTHESIS_EVIDENCE,
  );
  const synthesisItems = customSynthesisItems || rankedSynthesis;

  // ── Assign compact E1..En IDs ─────────────────────────────────────────────
  const evidenceBlocks = synthesisItems.map((item, index) =>
    buildCompactEvidenceBlock(item, item.evidence_id || `E${index + 1}`),
  );

  // Pest-specific instructions injected only when the query intent is pest
  const pestInstructions = intent === 'pest' ? [
    `PEST QUERY INSTRUCTIONS (mandatory for QUERY_INTENT "pest"):`,
    `- Separate occurrence evidence from management evidence. Do NOT merge them into one research_finding.`,
    `- For each evidence block tagged DIRECT_EVIDENCE or INDIRECT_EVIDENCE that mentions specific management compounds (e.g. Chlorantraniliprole, Fenazaquin, Beauveria bassiana, NSKE, Pungam oil, intercropping) with a documented reduction percentage, create a distinct research_finding for that management approach.`,
    `- Preserve the Evidence type from each block exactly in evidence_strength (do NOT upgrade INDIRECT_EVIDENCE to DIRECT_EVIDENCE).`,
    `- If NO evidence block contains specific management compounds or efficacy data, set direct_answer to: "The retrieved evidence identifies these major pests and their occurrence, but does not provide sufficient evidence in the retrieved sources to give specific management recommendations." and farmer_guidance to a single item: "Farmers can use the reported pest occurrence information for monitoring and seek locally appropriate integrated pest-management recommendations when these pests are observed."`,
    `- Never invent pesticide names, doses, or application rates not present in the supplied evidence.`,
    '',
  ] : [];

  // Nutrient-specific instructions injected only when the query intent is nutrition
  const nutrientInstructions = intent === 'nutrition' ? [
    `NUTRITION QUERY INSTRUCTIONS (mandatory for QUERY_INTENT "nutrition"):`,
    `- CRITICAL: Only use evidence blocks that explicitly contain fertilizer, nutrient, NPK, manure, nitrogen, phosphorus, potassium, micronutrient, or foliar nutrition keywords.`,
    `- Do NOT use pruning-only, Thiourea-only, plant-density-only, irrigation-only, or generic cultivation evidence blocks as nutrient evidence.`,
    `- A generic Jasminum sambac cultivation block is NOT nutrient evidence unless it explicitly contains nutrient/fertilizer-specific content.`,
    `- If NO supplied evidence block contains explicit nutrient/fertilizer content, you MUST set:`,
    `  direct_answer: "The retrieved evidence does not provide sufficient nutrient-specific information to reliably explain the effects of nitrogen, phosphorus, potassium, or other nutrient-management practices on growth, flowering, and yield in Jasminum sambac."`,
    `  research_findings: []`,
    `  farmer_guidance: []`,
    `- If valid nutrient evidence exists: synthesize only from those blocks. Report experiment-specific NPK/fertilizer findings exactly as stated; do not extrapolate.`,
    `- Never present pruning, Thiourea, plant spacing, or irrigation findings as answers to a nutrient-management question.`,
    '',
  ] : [];

  const prompt = [
    `USER QUESTION: ${query}`,
    `QUERY_INTENT: ${intent}`,
    `Prioritize evidence relevant to query_intent "${intent}".`,
    `Return one factor object per distinct causal/practice category.`,
    `Do NOT merge different treatments under one factor label.`,
    `If a treatment is "Thiourea + pruning", label the factor "Flower-inducing treatment" and describe it as a study-specific finding: "The retrieved study reported increased flowering when 0.5% Thiourea was combined with pruning under the tested conditions. This should be treated as a study-specific finding rather than a universal recommendation."`,
    `For November pruning, describe it as a study-specific finding: "The retrieved study reported higher flower production for the tested November pruning schedule; farmers should compare this finding with locally appropriate recommendations."`,
    `Use only E1–E${ synthesisItems.length } as evidence_ids.`,
    `If nitrogen is discussed: note that vegetative growth does NOT establish flower yield. If nitrogen is not discussed, do NOT include a nitrogen warning.`,
    ...pestInstructions,
    ...nutrientInstructions,
    '',
    `EVIDENCE (${synthesisItems.length} items selected from ${allItems.length} retrieved):`,
    evidenceBlocks.join('\n\n'),
  ].join('\n');

  if (process.env.RAG_DEBUG_SYNTHESIS === '1') {
    logger.info({
      query,
      intent,
      retrievedCount: allItems.length,
      synthesisCount: synthesisItems.length,
      promptCharacters: prompt.length,
      promptTokenEstimate: Math.ceil(prompt.length / 4),
      model: env.OPENROUTER_MODEL,
      maxOutputTokens: Number(process.env.RAG_SYNTHESIS_MAX_OUTPUT_TOKENS || 400),
      synthesisEvidenceIds: synthesisItems.map((item, i) => `${item.evidence_id || `E${i + 1}`} → ${item.source_id}`),
    }, 'SYNTHESIS INPUT');
  }

  return prompt;
}

export function buildGeneralEvidenceItems(
    chunks: GeneralChunk[],
    evidencePackets?: GeneralEvidencePacket[],
  ): GeneralEvidenceItem[] {
    const packets = evidencePackets || [{
      id: 'q1',
      question: '',
      evidence_status: chunks.length ? 'DIRECT_EVIDENCE' as const : 'INSUFFICIENT_EVIDENCE' as const,
      evidence_message: '',
      top_score: 0,
      chunks,
    }];
    const items: GeneralEvidenceItem[] = [];
    const seen = new Set<string>();
    for (const packet of packets) {
      for (const chunk of packet.chunks) {
        const evidence = extractGeneralEvidence(chunk, packet.question);
        if (evidence.evidence_class === 'METADATA_ONLY' || !evidence.finding) continue;
        const categories = categoriesForEvidence(`${evidence.topic} ${evidence.finding} ${chunk.title || ''}`);
        for (const category of categories) {
          const key = [
            category,
            evidence.source_id,
            evidence.finding,
            evidence.reported_value,
            evidence.conditions,
          ].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            evidence_id: `E${items.length + 1}`,
            category,
            source_id: evidence.source_id,
            paper_title: evidence.title,
            classification: evidence.evidence_class,
            finding: evidence.finding,
            experimental_conditions: evidence.conditions,
            quantitative_result: evidence.reported_value || 'Not stated',
            outcome_domain: evidence.outcome_domain,
            reproductive_output_supported: evidence.supports_reproductive_output,
            year: chunk.year,
          });
        }
      }
    }
    return items;
  }
const SYSTEM_PROMPT = `You are JasmineGPT, an evidence-grounded AI assistant for jasmine farmers.

PURPOSE
Answer user questions using ONLY the retrieved research context provided with the request.

## Core Rules

1. Use only retrieved evidence.
2. Never use pretrained knowledge, assumptions, or external information.
3. Every factual claim must be supported by the retrieved text.
4. If evidence is missing, state that clearly instead of guessing.

## Evidence Priority

Determine relevance in this order:

1. Retrieved text (highest priority)
2. Paper title
3. Experimental description
4. Metadata category (lowest priority)

Do not reject a relevant paper because its metadata category is incorrect.

## Species & Cultivar Safety

Target species:
- Jasminum sambac
- Jasminum auriculatum

Never present results from another species as direct evidence.

If only cross-species evidence exists, explicitly label it as:
"Cross-species evidence."

Always preserve cultivar names exactly as reported (e.g., Gundumalli, Mogra).

## Numerical Safety

Never invent, estimate, round, or calculate values for:
- fertilizer doses
- pesticide concentrations
- irrigation amounts
- temperature
- humidity
- spacing
- percentages
- storage duration
- treatment intervals

If the value is absent, say:

"The retrieved papers do not specify this value."

## Experimental Scope

Report findings exactly as the study reports them.

Use wording such as:
- "The study reported..."
- "In this experiment..."
- "For Jasminum sambac cv. Gundumalli..."

Do not convert experimental results into universal recommendations unless the source explicitly recommends them.

## Handling Partial Evidence

If retrieved evidence is directly relevant:
- Answer using the supported findings.
- Cite the paper title.

If evidence is only partially relevant:
- State what the research supports.
- Clearly identify what remains unsupported.
- Do not reply with insufficient evidence if useful partial evidence exists.

Return the exact sentence below ONLY when no retrieved text meaningfully answers the question:

"The available research does not provide sufficient evidence."

## Answer Style

Be concise, farmer-friendly, and scientifically accurate.

Never mention:
- similarity score
- embedding score
- vector search
- retrieval confidence

Attach each factual claim only to the retrieved paper title or source ID that directly supports that claim. Do not cite retrieved sources that do not contribute evidence to the final answer.`;

const FORMAT_INSTRUCTIONS = `
==================================================
RESPONSE FORMAT INSTRUCTIONS (MANDATORY)
==================================================
Format your response for a jasmine farmer using two layers. The first layer is a short farmer-facing answer; the second is supporting evidence that can be expanded or viewed separately. Do not let the evidence layer dominate the answer.

FARMER-FACING LAYER (MANDATORY):
- Start immediately with "🌸" and a natural direct answer. Do not begin with "The retrieved studies indicate" or RAG terminology.
- Use 3–6 bullets, about 80–150 words for compound questions and 50–100 words for simple questions.
- Select only the strongest 2–4 findings that directly answer the question. Prioritize actionable practices, concrete results, and one important caution.
- Include only numbers that help a farmer decide what the study tested; leave secondary measurements for the supporting evidence layer.
- Mention a cultivar briefly when needed, without repeating full species/cultivar wording.
- Use simple words such as flowering, flower production, pruning, spacing, and nutrient management.
- Keep claim-level citations on the bullets that use the findings. The Research Citations list must contain only those cited sources.
- End the farmer-facing layer with one short caution that experimental findings are not universal recommendations.

SUPPORTING EVIDENCE LAYER:
- Begin it with exactly "🔎 View supporting evidence".
- Put detailed source title, cultivar, conditions, detailed measurements, evidence classification, and source citation after that marker.
- Do not use supporting-only sources in the farmer-facing Research Citations list unless the short answer also uses a claim from them.

For a single-information question, use the concise farmer-facing layer and then the supporting evidence layer. For a compound question with multiple information requirements, use the compound structure rules that follow.

### 1. Direct Answer
Provide a concise 1–3 sentence synthesis based strictly on the retrieved evidence. Do not merely name a treatment as a biological factor: distinguish between factors or practices that the retrieved studies examined and outcomes they reported.
- If the retrieved evidence directly answers the question, give the direct finding.
- If the retrieved evidence only partially answers the question, answer what is supported by the evidence and clearly state which requested details are unavailable.

### 2. Evidence from Retrieved Studies
Present the evidence clearly for each relevant study:
- **Paper Title**: [Exact paper title]
- **Key Finding**: [Main finding from the study]
- **Experimental Conditions**: [Specific parameters tested: temperature, packaging, treatment/chemicals, cultivar, storage duration, etc.]
- **Reported Outcome**: [Specific measured results and metrics, ONLY if explicitly present in the text]

*(Note: When comparing multiple treatments, conditions, or papers, you may use a clean markdown table. Synthesize findings across papers without merging separate experimental results into a single generalized recommendation.)*

### 3. Research Scope
Provide exactly 1 sentence stating that findings apply only to the tested experimental conditions and specific cultivars/treatments evaluated.

COMPOUND-QUESTION COMPLETENESS (MANDATORY):
- First identify every distinct information requirement in the user's question. Do not answer only the first clause or the most strongly retrieved clause.
- For a question such as "What factors influence flowering and yield in jasmine, and how can farmers improve flower production?", include all of these sections:
  1. "### Direct Answer"
  2. "### Factors influencing flowering and yield"
  3. "### How flower production may be improved"
  4. "### Evidence limitation" when any requested factor or practice lacks direct evidence
  5. "### Research Scope"
- Under "### Factors influencing flowering and yield", list only factors or experimental practices directly supported by result-bearing passages. For each item, state the treatment/practice, the actual reported result, species/cultivar, location or other conditions when available, and the claim-level citation.
- Use precise wording such as: "The retrieved studies examined the effects of Thiourea treatment on flowering and planting spacing on flower yield." Do not write "Factors influencing flowering include Thiourea" unless the evidence establishes that broader claim.
- Under "### How flower production may be improved", translate only direct findings into cautious, study-scoped management statements. For example: "In the retrieved study on Jasminum sambac cv. Gundumalli, 0.5% Thiourea was associated with earlier flower initiation and higher flower-related parameters under the reported experimental conditions." Do not write "Farmers should use 0.5% Thiourea."
- A spacing finding must remain a spacing finding: "A study on Jasminum sambac reported the highest yield of 4095.26 kg/ha at 2 × 1 m spacing among the tested spacing treatments." Do not turn it into a universal recommendation.
- If a retrieved passage only says that nitrogen is important for growth or branching, report that limited finding and do not call it "optimal nitrogen" or infer an optimum dose. If no direct flower-yield result is available, state the evidence gap.
- Repeat the relevant claim-level citations in the factors and practices sections as needed. Do not create a citation list containing retrieved sources that did not support a final claim.

- SYMPTOM RESPONSES & EVIDENCE GAP HANDLING:
  * When the user asks about a specific symptom, damage, observation, or plant disorder (e.g., small unopened buds, yellowing leaves, premature bud drop, wilting, curling, etc.):
  * Identify whether the retrieved study directly investigates the user's specific symptom.
  * If no retrieved study directly investigates the symptom:
    - In "### 1. Direct Answer", begin with: "The retrieved research does not directly investigate this symptom."
    - Rename Section 2 from "### 2. Evidence from Retrieved Studies" to "### 2. Related Evidence from Retrieved Studies".
    - Label individual studies under "#### Related Evidence" (never under Direct Evidence).
    - NEVER write causal phrases such as:
      * "This could be caused by..."
      * "Other factors such as..."
      * "Therefore it may be due to..."
      * "This may be caused by..."
      * "This may explain why..."
      * "This could be due to..."
    - Instead write:
      "The retrieved study evaluated [evaluated practice X], but it did not investigate the cause of this symptom."
    - End with a clear evidence-gap statement when no direct symptom evidence exists (e.g., "No direct evidence on the cause or diagnosis of this symptom is evaluated in the retrieved research.").
    - Do NOT infer causes from pretrained knowledge or speculate on causes.
    - Keep the evidence summary brief (3–5 lines).
- CULTIVAR SPECIFICITY & CROSS-CULTIVAR SEPARATION:
  * When the user specifies a cultivar (e.g., Ramanathapuram Gundumalli, Gundumalli, Baramasi, etc.), prioritize retrieved studies for that exact cultivar.
  * Present results under two separate headings when multiple cultivars are retrieved:
    - "### Direct Evidence ([Target Cultivar Name])" for studies on the same species, same cultivar, and same management topic.
    - "### Related Cultivar Evidence ([Other Cultivar Name])" for studies on the same species but a different cultivar. Clearly label it as related evidence and do NOT merge it into the direct recommendation.
  * NEVER write "You should..." using cross-cultivar evidence. State that findings apply to the tested cultivar's experimental conditions.
  * Preserve all cultivar names exactly as retrieved.
- TOPIC RELEVANCE: Focus strictly on the primary management practice/topic requested in the user question. Include only evidence from retrieved studies whose title or text directly evaluates that requested management intervention. Exclude any study where flowering, growth, or yield is merely the outcome of an unrelated management practice (e.g., exclude pruning when asked about fertilizer).
- 1:1 CLAIM CITATION CONSISTENCY: Every factual finding used in the answer must have a corresponding source ID or exact paper-title citation from the claim-citation ledger. The "Research Citations" list must contain only sources that support at least one final claim. Do not list every retrieved study and never cite a title-only or related passage as direct evidence.
- Use ONLY facts and numerical values directly stated in the retrieved text. Never invent, estimate, or extrapolate facts or numbers.
- Preserve species, cultivar, author, year, and all numerical values exactly as retrieved.
- Never mention similarity scores, embedding scores, vector search, or retrieval confidence.
- Keep the overall response concise and under ~350 words unless the user explicitly requested detailed research.
- If and ONLY if NONE of the retrieved chunks meaningfully answer the user's question, output strictly:
"The available research does not provide sufficient evidence."
(Do NOT output this sentence when useful partial evidence exists).`;

const POSTHARVEST_FORMAT_INSTRUCTIONS = `
==================================================
RESPONSE FORMAT INSTRUCTIONS (MANDATORY FOR POST-HARVEST)
==================================================
Synthesize the response strictly from the retrieved post-harvest evidence.

### 1. Direct Answer
Provide a concise 2–3 sentence synthesis of the post-harvest practices evaluated in the retrieved studies (e.g. chitosan coating, cold storage packaging with boric acid and polythene, mycelium foam packaging for transport).
CRITICAL RULES FOR DIRECT ANSWER:
- Do NOT mention flowering or flower yield.
- NEVER produce "Flowering and yield were linked to the treatments and practices reported in the retrieved studies." or any equivalent generic flowering/yield boilerplate.
- Only mention post-harvest handling, coating, packaging, storage, or preservation methods actually present in the retrieved evidence.
- State that these findings are specific to the experimental conditions reported in the respective studies.

### 2. Evidence from Retrieved Studies
Present the evidence clearly for each relevant study:
- **Paper Title**: [Exact paper title]
- **Key Finding**: [Main finding regarding shelf life, freshness, PLW, or quality]
- **Experimental Conditions**: [Specific parameters tested: packaging, chemical treatment, temperature, storage duration, etc.]
- **Reported Outcome**: [Specific measured results: freshness %, PLW %, shelf life hours, ONLY if explicitly in text]

### 3. Research Scope
Provide exactly 1 sentence stating: "These are study-specific findings, not universal recommendations."
`;

function buildPostHarvestPrompt(
  query: string,
  documents: PostHarvestDoc[],
  profileFacts: ProfileFact[],
  resolvedQuery: string,
  chunks?: PostHarvestChunk[],
  targetCultivar?: string,
  targetSpecies?: string,
): string {
  const contextBlocks = documents.map((doc) => {
    const facts = profileFacts.find((p) => p.document_id === doc.document_id);
    const docChunks = chunks ? chunks.filter((c) => c.document_id === doc.document_id) : [];

    const lines: string[] = [
      `SOURCE:\n${doc.title} (${doc.authors}, ${doc.year}) [ID: ${doc.document_id}]`,
      `SPECIES:\n${doc.species} | CULTIVAR: ${doc.cultivar}`,
    ];
    if (doc.limitations) {
      lines.push(`LIMITATIONS:\n${doc.limitations}`);
    }
    if (facts && facts.facts.length > 0) {
      lines.push(`VERIFIED FACTS:\n${facts.facts.map((f) => `- ${f}`).join('\n')}`);
    }
    if (docChunks.length > 0) {
      lines.push(`EVIDENCE TEXT:\n${docChunks.map((c) => c.text).join('\n\n')}`);
    }
    return lines.join('\n\n');
  });

  const contextText = contextBlocks.join('\n\n==================================================\n\n');

  const isSymptom = isSymptomQuery(resolvedQuery || query);
  const symptomHeader = isSymptom
    ? `[SYMPTOM QUERY NOTICE]\n` +
      `The user is asking about a plant symptom/observation. If no retrieved study directly investigates this symptom:\n` +
      `1. Begin Direct Answer with: "The retrieved research does not directly investigate this symptom."\n` +
      `2. Rename Section 2 heading to "### 2. Related Evidence from Retrieved Studies".\n` +
      `3. Label the study under "#### Related Evidence".\n` +
      `4. Write: "The retrieved study evaluated post-harvest storage and packaging conditions, but it did not investigate the cause of this symptom."\n` +
      `5. NEVER write causal phrases like "This could be caused by...", "Other factors such as...", or "Therefore it may be due to...".\n` +
      `6. End with a clear evidence-gap statement.\n\n`
    : '';

  // Chunk-aware cultivar separation + evidence-scoped Direct Answer wording
  const cultivarInstruction = buildCultivarInstruction(
    documents.slice(0, 4).map((d) => ({ title: d.title, text: '', cultivar: d.cultivar })),
    targetCultivar
  );

  // Active-species header: prevents LLM from mixing evidence from other jasmine species
  const speciesHeader = targetSpecies
    ? `ACTIVE SPECIES: ${targetSpecies}\n` +
      `The user grows ${targetSpecies}. Present ONLY studies on ${targetSpecies} as direct evidence.\n` +
      `If a retrieved study is on a different jasmine species, present it ONLY under a clearly labelled section: "#### Related Species Evidence" and NEVER as a direct recommendation.\n\n`
    : '';

  return (
    `==================================================\n` +
    `CONTEXT\n` +
    `==================================================\n\n` +
    `${contextText}\n\n` +
    `==================================================\n` +
    `USER QUESTION\n` +
    `==================================================\n\n` +
    `${speciesHeader}` +
    `${cultivarInstruction}` +
    `${symptomHeader}` +
    `${resolvedQuery || query}\n\n` +
    POSTHARVEST_FORMAT_INSTRUCTIONS
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cultivar-separation instruction builder (used by buildGeneralPrompt)
// ─────────────────────────────────────────────────────────────────────────────

/** Known cultivar aliases → canonical display names, longest first. */
const CULTIVAR_ALIASES_FOR_DETECTION: Array<[string, string]> = [
  ['ramanathapuram gundumalli', 'Ramanathapuram Gundumalli'],
  ['mysuru mallige', 'Mysuru Mallige'],
  ['mysore mallige', 'Mysuru Mallige'],
  ['double mogra', 'Double Mogra'],
  ['single mogra', 'Single Mogra'],
  ['pacha mullai', 'Pacha Mullai'],
  ['muthu mullai', 'Muthu Mullai'],
  ['gundumalli', 'Gundumalli'],
  ['baramasi', 'Baramasi'],
  ['mogra', 'Mogra'],
  ['co-1', 'CO-1'],
  ['co-2', 'CO-2'],
];

/** Scan chunk titles + text for known cultivar names. */
function detectCultivarsInChunks(chunks: { title?: string; text?: string; cultivar?: string }[]): Set<string> {
  const found = new Set<string>();
  for (const c of chunks) {
    const haystack = `${c.title || ''} ${c.text || ''} ${c.cultivar || ''}`.toLowerCase();
    for (const [alias, canonical] of CULTIVAR_ALIASES_FOR_DETECTION) {
      if (haystack.includes(alias)) {
        found.add(canonical);
        break; // one per chunk
      }
    }
  }
  return found;
}

/**
 * Builds a cultivar-separation + evidence-scoped wording instruction block.
 *
 * Fires when:
 *   a) An explicit targetCultivar is set, OR
 *   b) Multiple cultivars are detected in the retrieved chunks.
 *
 * Always mandates evidence-scoped Direct Answer language to prevent absolute
 * recommendations like "December 2nd week is the best pruning time."
 */
function buildCultivarInstruction(
  chunks: { title?: string; text?: string; cultivar?: string }[],
  targetCultivar?: string,
): string {
  const detectedCultivars = detectCultivarsInChunks(chunks);
  const hasMixed = detectedCultivars.size >= 2;
  const hasTarget = Boolean(targetCultivar);

  if (!hasTarget && !hasMixed) {
    // Single or unknown cultivar, no explicit target — only add scoped-wording rule
    return (
      `EVIDENCE-SCOPED DIRECT ANSWER (MANDATORY):\n` +
      `The "### 1. Direct Answer" section MUST use scoped language tied to the retrieved study's experimental conditions.\n` +
      `  ✗ NEVER: "December 2nd week is the best pruning time."\n` +
      `  ✓ ALWAYS: "Among the retrieved Jasminum sambac studies, pruning during the 2nd week of December was reported to produce higher flower yield under the tested experimental conditions."\n\n`
    );
  }

  // Determine the primary cultivar for the "Direct Evidence" label
  const primaryCultivar =
    targetCultivar ||
    (detectedCultivars.size >= 1 ? [...detectedCultivars][0] : null);

  const detectedList = [...detectedCultivars].join(', ');

  const lines: string[] = [];
  if (primaryCultivar) lines.push(`USER TARGET CULTIVAR: ${primaryCultivar}`);
  if (hasMixed) lines.push(`RETRIEVED CULTIVARS IN CONTEXT: ${detectedList}`);

  lines.push(
    `CULTIVAR SEPARATION RULES (MANDATORY):`,
    `1. TOPIC FILTER FIRST: Determine the primary management topic (e.g., fertilizer, pruning, irrigation, storage) requested by the user. Include ONLY studies whose intervention matches that topic. Completely EXCLUDE any unrelated intervention studies (e.g., do not include pruning studies in a fertilizer question), even if they share the same outcome (flowering or yield).`,
    `2. Inside "### 2. Evidence from Retrieved Studies", create two clearly labelled sub-sections for the remaining TOPIC-RELEVANT studies:`,
    `   a) "#### Direct Evidence${primaryCultivar ? ` (${primaryCultivar})` : ''}" — for studies on ${primaryCultivar || 'the target cultivar'} or studies that do not specify a cultivar.`,
    `   b) "#### Related Cultivar Evidence" — for studies on any OTHER cultivar (e.g., Baramasi when user grows Mogra). Name the other cultivar explicitly.`,
    `3. NEVER merge yield values, timing, or treatment results from different cultivars into one recommendation.`,
    `4. EVIDENCE-SCOPED DIRECT ANSWER (MANDATORY): "### 1. Direct Answer" MUST use scoped language:`,
    `   ✗ NEVER: "December 2nd week is the best pruning time."`,
    `   ✓ ALWAYS: "Among the retrieved Jasminum sambac studies, pruning during the 2nd week of December was reported to produce higher flower yield under the tested experimental conditions."`,
    `5. Every TOPIC-RELEVANT retrieved study must appear in exactly one sub-section. Do not omit any relevant studies.`,
    `6. Preserve all paper titles, cultivar names, numerical values, and citations exactly as retrieved.`,
  );

  return lines.join('\n') + '\n\n';
}

function buildGeneralPrompt(
  query: string,
  chunks: GeneralChunk[],
  resolvedQuery: string,
  targetCultivar?: string,
  targetSpecies?: string,
  evidencePackets?: GeneralEvidencePacket[],
  customSynthesisItems?: GeneralEvidenceItem[],
): string {
  return buildCompactGeneralPrompt(query, chunks, targetSpecies, targetCultivar, evidencePackets, customSynthesisItems);

  /*
  const contextBlocks = (evidencePackets || [{
    id: 'q1',
    question: query,
    evidence_status: chunks.length ? 'DIRECT_EVIDENCE' : 'INSUFFICIENT_EVIDENCE',
    evidence_message: '',
    top_score: 0,
    chunks,
  }]).map((packet) => {
    const packetChunks = packet.chunks;
    const packetEvidence = packetChunks.length
      ? packetChunks.map((c) => {
        const evidence = extractGeneralEvidence(c, packet.question);
        if (evidence.evidence_class === 'METADATA_ONLY') {
          return `SOURCE: ${evidence.title}\nEVIDENCE CLASS: METADATA_ONLY\nDo not use this passage as evidence.`;
        }
        if (evidence.evidence_class === 'INSUFFICIENT') {
          return `SOURCE: ${evidence.title}\nEVIDENCE CLASS: INSUFFICIENT\nThe retrieved passage does not contain a usable finding.`;
        }
        const lines = [
          `SOURCE ID:\n${evidence.source_id}`,
          `SOURCE:\n${evidence.title}${c.year ? ` (${c.year})` : ''}`,
          `EVIDENCE CLASS:\n${evidence.evidence_class}`,
          `TOPIC:\n${evidence.topic}`,
          `OUTCOME DOMAIN:\n${evidence.outcome_domain}`,
          `REPRODUCTIVE OUTPUT SUPPORTED:\n${evidence.supports_reproductive_output ? 'Yes' : 'No'}`,
          `SPECIES/CULTIVAR:\n${evidence.species || 'Not stated'}${evidence.cultivar ? ` / ${evidence.cultivar}` : ''}`,
          `FINDING:\n${evidence.finding}`,
          `CONDITIONS:\n${evidence.conditions}`,
          `REPORTED VALUE/UNITS:\n${evidence.reported_value || 'Not stated'}`,
        ];
        if (c.is_cross_species && c.cross_species_note) {
          lines.push(`CROSS-SPECIES NOTE:\n${c.cross_species_note}`);
        }
        return lines.join('\n\n');
      }).join('\n\n')
      : 'No usable evidence was retrieved for this sub-question.';
    const lines = [
      `SUB-QUESTION ${packet.id}: ${packet.question}`,
      `EVIDENCE STATUS: ${packet.evidence_status}`,
      `EVIDENCE GAP: ${packet.evidence_message || 'None reported.'}`,
      `EVIDENCE PACKET:\n${packetEvidence}`,
    ];
    return lines.join('\n\n');
  });

  const contextText = contextBlocks.join('\n\n==================================================\n\n');
  const claimLedger = [...new Map(
    (evidencePackets || [{ id: 'q1', question: query, evidence_status: 'DIRECT_EVIDENCE', evidence_message: '', top_score: 0, chunks }])
      .flatMap((packet) => packet.chunks.map((chunk) => extractGeneralEvidence(chunk, packet.question)))
      .filter((evidence) => evidence.evidence_class === 'DIRECT_EVIDENCE')
      .map((evidence) => [evidence.source_id, evidence] as const),
  ).values()]
    .map((evidence) =>
      `SOURCE ID: ${evidence.source_id}\nCLAIM SUPPORTED: ${evidence.finding}\nOUTCOME DOMAIN: ${evidence.outcome_domain}`,
    )
    .join('\n\n');
  const informationNeeds = [
    'A: What factors influence flowering and yield?',
    'B: How can farmers improve flower production using only study-supported, cautious implications?',
  ].join('\n');
  const matrixGroups = new Map<string, GeneralEvidenceObject[]>();
  for (const packet of (evidencePackets || [{
    id: 'q1',
    question: query,
    evidence_status: 'DIRECT_EVIDENCE' as const,
    evidence_message: '',
    top_score: 0,
    chunks,
  }])) {
    for (const chunk of packet.chunks) {
      const evidence = extractGeneralEvidence(chunk, packet.question);
      if (evidence.evidence_class !== 'DIRECT_EVIDENCE') continue;
      const topic = evidence.topic.toLowerCase();
      const normalizedTopic = /\bthiourea|flower induction|chemical treatment\b/i.test(topic)
        ? 'Flower-inducing treatments'
        : /\bprun/i.test(topic) ? 'Pruning'
          : /\bspacing\b/i.test(topic) ? 'Plant spacing'
            : /\bregulator|defoliation\b/i.test(topic) ? 'Growth regulators / defoliation'
              : /\bnitrogen|npk|manure|fertilizer|nutrition\b/i.test(topic) ? 'Nutrition / nitrogen'
                : evidence.topic || 'Other supported factor';
      const group = matrixGroups.get(normalizedTopic) || [];
      if (!group.some((item) => item.source_id === evidence.source_id)) group.push(evidence);
      matrixGroups.set(normalizedTopic, group);
    }
  }
  const evidenceMatrix = [...matrixGroups.entries()]
    .map(([factor, findings]) =>
      `FACTOR: ${factor}\n` +
      findings.map((evidence) =>
        `EVIDENCE: ${evidence.finding}\n` +
        `STRENGTH: DIRECT_EVIDENCE\n` +
        `DOMAIN: ${evidence.outcome_domain}\n` +
        `CULTIVAR/CONDITIONS: ${evidence.conditions}\n` +
        `SOURCE: ${evidence.source_id}`,
      ).join('\n'),
    )
    .join('\n\n');
  if (process.env.RAG_DEBUG_SYNTHESIS === '1') {
    logger.info({
      informationNeeds,
      evidenceGroups: [...matrixGroups.keys()],
      extractedClaims: [...matrixGroups.values()].flat().map((evidence) => evidence.finding),
      claimSourceMapping: [...matrixGroups.values()].flat().map((evidence) => ({
        claim: evidence.finding,
        source: evidence.source_id,
      })),
    }, 'General RAG synthesis evidence matrix');
  }

  const isSymptom = isSymptomQuery(resolvedQuery || query);
  const symptomHeader = isSymptom
    ? `[SYMPTOM QUERY NOTICE]\n` +
      `The user is asking about a plant symptom/observation. If no retrieved study directly investigates this symptom:\n` +
      `1. Begin Direct Answer with: "The retrieved research does not directly investigate this symptom."\n` +
      `2. Rename Section 2 heading to "### 2. Related Evidence from Retrieved Studies".\n` +
      `3. Label the study under "#### Related Evidence".\n` +
      `4. Write: "The retrieved study evaluated [evaluated topic X], but it did not investigate the cause of this symptom."\n` +
      `5. NEVER write causal phrases like "This could be caused by...", "Other factors such as...", or "Therefore it may be due to...".\n` +
      `6. End with a clear evidence-gap statement.\n\n`
    : '';

    // Chunk-aware cultivar separation + evidence-scoped Direct Answer wording
  const cultivarInstruction = buildCultivarInstruction(chunks.slice(0, 4), targetCultivar);

  // Active-species header: prevents LLM from mixing evidence from other jasmine species
  const speciesHeader = targetSpecies
    ? `ACTIVE SPECIES: ${targetSpecies}\n` +
      `The user grows ${targetSpecies}. Present ONLY studies on ${targetSpecies} as direct evidence.\n` +
      `If a retrieved study is on a different jasmine species, present it ONLY under a clearly labelled section: "#### Related Species Evidence" and NEVER as a direct recommendation.\n\n`
    : '';

  return (
    `==================================================\n` +
    `CONTEXT\n` +
    `==================================================\n\n` +
    `${contextText}\n\n` +
    `==================================================\n` +
    `USER QUESTION\n` +
    `==================================================\n\n` +
    `${speciesHeader}` +
    `${cultivarInstruction}` +
    `${symptomHeader}` +
    `INFORMATION NEEDS (MUST BOTH BE ANSWERED):\n${informationNeeds}\n\n` +
    `EVIDENCE MATRIX (AUTHORITATIVE CLAIM CANDIDATES):\n${evidenceMatrix || 'No direct-evidence matrix entries are available.'}\n\n` +
    `CLAIM-CITATION LEDGER (AUTHORITATIVE):\n${claimLedger || 'No direct-evidence claim is available.'}\n\n` +
    `Answer each sub-question independently. Do not reuse evidence from one packet for another.\n` +
    `SYNTHESIS REQUIREMENTS (MANDATORY):\n` +
    `- Classify each passage as DIRECT, RELATED, or INSUFFICIENT based on its actual evidence text, not its title.\n` +
    `- Group supported findings by the factor or practice actually described in the evidence; infer group labels from the passages and metadata without inventing factors.\n` +
    `- Answer both the factors-influencing-flowering/yield part and the practices-improving-production part.\n` +
    `- First map each direct finding to a factor in the evidence matrix, then select one concise claim per major supported factor. Do not simply summarize the first chunks.\n` +
    `- For this compound question, cover the major supported factors across the matrix, including flower-inducing treatments, pruning, spacing, growth regulators, and nutrition when DIRECT_EVIDENCE exists. Keep nitrogen as vegetative-growth evidence unless reproductive output is explicitly supported.\n` +
    `- After the factor bullets, add a short "How farmers may use these findings" list with cautious implications: compare practices locally, consider tested treatments only under appropriate guidance, and evaluate spacing/nutrition by cultivar and field conditions. Do not prescribe a universal dose, schedule, or spacing.\n` +
    `- When the query asks both what influences flowering/yield and how to improve production, use two distinct sections: "Factors influencing flowering and yield" and "Practices reported to improve flower production".\n` +
    `- Synthesize findings across multiple passages. Never copy one passage into Direct Answer and never use raw journal headers as a finding.\n` +
    `- Do not copy retrieved passages verbatim into Direct Answer. Use PASSAGE -> FINDING -> CLAIM -> SYNTHESIS. The Direct Answer must be 60–120 words, 3–6 short bullets, with only important numbers; put exact measurements, tables, conditions, and metadata in the evidence section.\n` +
    `- Preserve each study's species, cultivar, location, treatment, conditions, values, and citation. Do not merge different experiments.\n` +
    `- Do not use words such as "optimal", "best", "recommended", or "should use" unless the evidence passage explicitly reports that wording or an explicitly tested optimum. Otherwise say that the treatment was associated with the reported outcome under the tested conditions.\n` +
    `- For every factual claim, cite only the SOURCE ID or SOURCE title whose finding directly supports that claim. Do not list retrieved-but-unused sources in Research Citations. Mark title-only or non-result passages RELATED or INSUFFICIENT and do not use them for strong claims.\n` +
    `- Build "Research Citations" from the claim-citation ledger only: include each source ID at least once if and only if its finding supports a claim actually used in the answer. Do not include a retrieved source merely because its title or category is relevant.\n` +
    `- Keep claim mappings explicit when useful, using "Claim: ... — Source: ...". A source may support multiple claims, but never cite it for a claim outside its ledger finding.\n` +
    `- If a direct finding is unavailable, state the evidence gap instead of inferring a result from the paper title or general agricultural knowledge.\n` +
    `- If a factor is not directly supported by a passage, state that the retrieved corpus did not provide sufficient direct evidence for it.\n` +
        `- Avoid strong causal or universal wording such as "ensures", "always", "best", "optimal", "guarantees", or "universally recommended" unless the retrieved passage explicitly supports that wording.\n` +
        `- Treat nitrogen statements about plant height, branching, or vegetative growth as limited to those outcomes; do not convert them into a flower-yield claim unless the same passage explicitly reports flower yield.\n` +
        `- Treat chemical-defoliation passages as RELATED_EVIDENCE or INSUFFICIENT when they contain only background, affiliations, observations, or metadata without a concrete measured result. Never infer a result from the paper title.\n` +
        `- Keep VEGETATIVE_GROWTH evidence (height, branches, leaves, shoots, vigor, biomass) separate from REPRODUCTIVE_OUTPUT evidence (flowers, buds, cymes, flower weight, flower yield, yield per plant/hectare). Never transfer one domain into the other.\n` +
        `- A source is DIRECT_EVIDENCE only for the specific claim and outcome domain supported by its retrieved passage. A relevant title or category is never sufficient; if source 392's passage lacks a concrete result used in the answer, classify it as RELATED_EVIDENCE or INSUFFICIENT and omit it from Direct Evidence citations.\n` +
        `- Before responding, self-check: no nitrogen-to-yield inference; no title-only claim; every Direct Evidence citation has a supporting passage; irrelevant retrieved sources are omitted; cultivar and experimental context are preserved; evidence gaps are stated.\n` +
        `- If the evidence does not explicitly report an optimal dose, schedule, or treatment, include exactly: "The retrieved evidence does not specify an optimal dose/schedule."\n` +
    `${resolvedQuery || query}\n\n` +
    FORMAT_INSTRUCTIONS
  );
  */
}

export interface LLMCallTelemetry {
  provider: 'OpenRouter' | 'Gemini';
  model: string;
  requestStatus: 'SUCCESS' | 'FAILED';
  httpStatus: number | null;
  apiCalls: number;
  requestTimestamp: string;
  responseTimestamp: string;
  apiLatencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  tokenUsageStatus: 'AVAILABLE' | 'UNAVAILABLE';
}

export interface SynthesisExecutionTelemetry {
  llm: LLMCallTelemetry;
  parsingLatencyMs: number;
  validationLatencyMs: number;
  validJson: boolean;
  validationPassed: boolean;
}

export async function callLLM(
  userPrompt: string,
  systemPrompt: string = SYSTEM_PROMPT,
  maxOutputTokens = 800,
  responseSchema?: JsonSchema,
  onTelemetry?: (t: LLMCallTelemetry) => void,
): Promise<string> {
  const provider = env.LLM_PROVIDER;
  const apiKey = provider === 'gemini' ? env.GEMINI_API_KEY : env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw Errors.MISSING_API_KEY();
  }

  const diagnosticLogging = process.env.RAG_DEBUG_LLM === '1';
  const requestModel = provider === 'gemini' ? env.GEMINI_MODEL : env.OPENROUTER_MODEL;
  const requestedMaxTokens = maxOutputTokens;
  if (diagnosticLogging) {
    logger.info({
      provider: provider === 'gemini' ? 'Gemini' : 'OpenRouter',
      model: requestModel,
      promptTokenEstimate: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
      requestedMaxTokens,
    }, 'LLM generation request');
  }

  const reqTimestamp = new Date().toISOString();
  const tStart = process.hrtime.bigint();

  try {
    if (provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: requestModel,
        contents: `${systemPrompt}\n\n${userPrompt}`,
        config: {
          temperature: 0.2,
          maxOutputTokens: requestedMaxTokens,
          responseMimeType: responseSchema ? 'application/json' : undefined,
          responseSchema: responseSchema,
        },
      });
      const tEnd = process.hrtime.bigint();
      const resTimestamp = new Date().toISOString();
      const apiLatencyMs = Number(tEnd - tStart) / 1_000_000;
      const content = response.text?.trim() || '';

      if (onTelemetry) {
        onTelemetry({
          provider: 'Gemini',
          model: requestModel,
          requestStatus: content ? 'SUCCESS' : 'FAILED',
          httpStatus: 200,
          apiCalls: 1,
          requestTimestamp: reqTimestamp,
          responseTimestamp: resTimestamp,
          apiLatencyMs: Math.round(apiLatencyMs * 100) / 100,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          cachedTokens: null,
          tokenUsageStatus: 'UNAVAILABLE',
        });
      }

      if (diagnosticLogging) {
        logger.info({
          provider: 'Gemini',
          model: requestModel,
          status: content ? 'SUCCESS' : 'FAILED',
          httpStatus: 200,
          responseReceived: Boolean(content),
          responseLength: content.length,
          jsonParsing: responseSchema ? Boolean(content) : undefined,
          fallbackUsed: false,
        }, 'LLM generation result');
      }
      if (!content) throw new Error('Empty LLM response');
      return content;
    }

    const response = await axios.post(
      `${env.OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: env.OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: requestedMaxTokens,
        ...(responseSchema ? { response_format: { type: 'json_object' } } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5173',
          'X-Title': 'JasmineGPT',
        },
        timeout: 30_000,
      },
    );

    const tEnd = process.hrtime.bigint();
    const resTimestamp = new Date().toISOString();
    const apiLatencyMs = Number(tEnd - tStart) / 1_000_000;

    const content: string = response.data?.choices?.[0]?.message?.content ?? '';

    // Collect provider-reported token usage
    const usage = response.data?.usage;
    const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
    const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : null;
    const cachedTokens = typeof usage?.prompt_tokens_details?.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens
      : null;

    if (onTelemetry) {
      onTelemetry({
        provider: 'OpenRouter',
        model: env.OPENROUTER_MODEL,
        requestStatus: content ? 'SUCCESS' : 'FAILED',
        httpStatus: response.status,
        apiCalls: 1,
        requestTimestamp: reqTimestamp,
        responseTimestamp: resTimestamp,
        apiLatencyMs: Math.round(apiLatencyMs * 100) / 100,
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        tokenUsageStatus: totalTokens !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      });
    }

    if (diagnosticLogging) {
      logger.info({
        provider: 'OpenRouter',
        model: requestModel,
        status: content ? 'SUCCESS' : 'FAILED',
        httpStatus: response.status,
        responseReceived: Boolean(content),
        responseLength: content.length,
        jsonParsing: responseSchema ? Boolean(content) : undefined,
        fallbackUsed: false,
      }, 'LLM generation result');
    }
    if (!content) throw new Error('Empty LLM response');
    return content;
  } catch (err) {
    const axErr = err as AxiosError;
    const tEnd = process.hrtime.bigint();
    const resTimestamp = new Date().toISOString();
    const apiLatencyMs = Number(tEnd - tStart) / 1_000_000;

    if (onTelemetry) {
      onTelemetry({
        provider: provider === 'gemini' ? 'Gemini' : 'OpenRouter',
        model: requestModel,
        requestStatus: 'FAILED',
        httpStatus: axErr.response?.status ?? null,
        apiCalls: 1,
        requestTimestamp: reqTimestamp,
        responseTimestamp: resTimestamp,
        apiLatencyMs: Math.round(apiLatencyMs * 100) / 100,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        cachedTokens: null,
        tokenUsageStatus: 'UNAVAILABLE',
      });
    }

    if (diagnosticLogging) {
      const providerMessage = (
        axErr.response?.data as { error?: { message?: string } } | undefined
      )?.error?.message;
      logger.error({
        provider: provider === 'gemini' ? 'Gemini' : 'OpenRouter',
        model: requestModel,
        status: 'FAILED',
        httpStatus: axErr.response?.status,
        errorCode: axErr.code,
        errorMessage: providerMessage || (err instanceof Error ? err.message : 'Unknown LLM error'),
        responseReceived: false,
        jsonParsing: false,
        fallbackUsed: false,
      }, 'LLM generation failure');
    } else {
      logger.error({ status: axErr.response?.status }, 'LLM call failed');
    }
    if (axErr.code === 'ECONNREFUSED') throw Errors.LLM_UNAVAILABLE();
    if (axErr.response?.status === 401) throw Errors.MISSING_API_KEY();
    throw Errors.LLM_UNAVAILABLE();
  }
}

export function isLlmConfigured(): boolean {
  return env.LLM_PROVIDER === 'gemini'
    ? Boolean(env.GEMINI_API_KEY)
    : Boolean(env.OPENROUTER_API_KEY);
}

export { buildPostHarvestPrompt, buildGeneralPrompt, parseStructuredResponse };
