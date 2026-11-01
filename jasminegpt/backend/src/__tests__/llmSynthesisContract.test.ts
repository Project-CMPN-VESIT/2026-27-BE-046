import {
  detectQueryIntent,
  validateAndRepairStructuredResponse,
  buildRankedSynthesisEvidence,
} from '../services/llm/llmService';
import type {
  GeneralEvidenceCoverage,
  GeneralEvidenceItem,
  GeneralStructuredResponse,
} from '../services/llm/llmService';
import { formatGeneralFallback } from '../controllers/chatController';
import type { GeneralChunk } from '../types';

const items: GeneralEvidenceItem[] = [
  'Flower-inducing treatments',
  'Pruning',
  'Plant spacing',
  'Growth regulators',
  'Nutrient management',
].map((category, index) => ({
  evidence_id: `E${index + 1}`,
  category: category as GeneralEvidenceItem['category'],
  source_id: `paper-${index + 1}.pdf`,
  paper_title: `Paper ${index + 1}`,
  classification: 'DIRECT_EVIDENCE' as const,
  finding: `${category} finding under tested conditions.`,
  experimental_conditions: 'Tested conditions',
  quantitative_result: '',
  outcome_domain: 'REPRODUCTIVE_OUTPUT' as const,
  reproductive_output_supported: true,
}));

const coverage: GeneralEvidenceCoverage[] = items.map((item) => ({
  category: item.category,
  classification: item.classification,
  finding: item.finding,
  source_ids: [item.source_id],
  reproductive_output_supported: item.reproductive_output_supported,
}));

function response(overrides: Partial<GeneralStructuredResponse> = {}): GeneralStructuredResponse {
  const baseResearchFindings = items.map((item) => ({
    factor: item.category,
    finding: item.finding,
    source_ids: [item.evidence_id],
  }));
  const baseGuidance = items.map((item) => ({
    text: `Compare the reported ${item.category} result with local recommendations.`,
    source_ids: [item.evidence_id],
  }));
  return {
    direct_answer: 'Study findings vary by treatment and conditions.',
    research_findings: baseResearchFindings,
    farmer_guidance: baseGuidance,
    factors: items.map((item) => ({
      factor: item.category,
      finding: item.finding,
      farmer_interpretation: 'Compare with local recommendations.',
      source_ids: [item.evidence_id],
    })),
    farmer_actions: [],
    supporting_evidence: [],
    caution: 'Findings are study-specific.',
    ...overrides,
  };
}

describe('structured synthesis contract', () => {
  it('classifies flowering, yield, and mixed queries semantically', () => {
    expect(detectQueryIntent('What factors influence flowering in Jasminum sambac, and how can farmers improve flower production?')).toBe('flowering');
    expect(detectQueryIntent('What factors influence yield in Jasminum sambac, and how can farmers improve flower production?')).toBe('yield');
    expect(detectQueryIntent('What factors influence flowering and yield in Jasminum sambac, and how can farmers improve flower production?')).toBe('mixed');
  });

  // A: required fields
  it('A: response contains direct_answer, research_findings, and farmer_guidance', () => {
    const result = validateAndRepairStructuredResponse(response(), coverage, items);
    expect(typeof result.response.direct_answer).toBe('string');
    expect(Array.isArray(result.response.research_findings)).toBe(true);
    expect(result.response.research_findings.length).toBeGreaterThan(0);
    expect(Array.isArray(result.response.farmer_guidance)).toBe(true);
  });

  // B: research_findings evidence IDs
  it('B: research_findings items resolve to valid source filenames', () => {
    const result = validateAndRepairStructuredResponse(response(), coverage, items);
    for (const finding of result.response.research_findings) {
      expect(Array.isArray(finding.source_ids)).toBe(true);
      expect(finding.source_ids.every((id) => id.endsWith('.pdf'))).toBe(true);
    }
  });

  // C: farmer_guidance evidence IDs
  it('C: farmer_guidance items with resolved IDs reference actual source filenames', () => {
    const result = validateAndRepairStructuredResponse(response(), coverage, items);
    const guidanceWithIds = result.response.farmer_guidance.filter((g) => g.source_ids.length > 0);
    for (const guidance of guidanceWithIds) {
      expect(guidance.source_ids.every((id) => id.endsWith('.pdf'))).toBe(true);
    }
  });

  // D: invalid evidence IDs rejected
  it('D: invalid evidence IDs in farmer_guidance are detected and item is dropped', () => {
    const result = validateAndRepairStructuredResponse(
      response({
        farmer_guidance: [{ text: 'Compare with local recommendations.', source_ids: ['INVALID_ID_XYZ'] }],
      }),
      coverage,
      items,
    );
    expect(result.invalidEvidenceIds).toContain('INVALID_ID_XYZ');
    const kept = result.response.farmer_guidance.filter((g) => g.source_ids.length > 0);
    expect(kept.every((g) => !g.source_ids.includes('INVALID_ID_XYZ'))).toBe(true);
  });

  // E: guidance not from unsupported content (duplicate filter)
  it('E: farmer_guidance items identical to research_findings are removed', () => {
    const findingText = 'Flower-inducing treatments finding under tested conditions.';
    const result = validateAndRepairStructuredResponse(
      response({
        farmer_guidance: [{ text: findingText, source_ids: ['E1'] }],
      }),
      coverage,
      items,
    );
    const survived = result.response.farmer_guidance.find((g) => g.text === findingText);
    expect(survived).toBeUndefined();
  });

  // F: nitrogen safety
  it('F: nitrogen safety: research_finding claiming nitrogen increases flower yield is rewritten', () => {
    const nitrogenItem: GeneralEvidenceItem = {
      ...items[0],
      evidence_id: 'E6',
      category: 'Nitrogen / vegetative growth',
      source_id: 'nitrogen.pdf',
      finding: 'Nitrogen increased plant height and branches.',
      reproductive_output_supported: false,
    };
    const nitrogenCoverage: GeneralEvidenceCoverage = {
      category: nitrogenItem.category,
      classification: 'DIRECT_EVIDENCE',
      finding: nitrogenItem.finding,
      source_ids: [nitrogenItem.source_id],
      reproductive_output_supported: false,
    };
    const result = validateAndRepairStructuredResponse({
      ...response(),
      research_findings: [{
        factor: 'Nitrogen / vegetative growth',
        finding: 'Nitrogen increases flower yield.',
        source_ids: ['E6'],
      }],
      factors: [{
        factor: 'Nitrogen / vegetative growth',
        finding: 'Nitrogen increases flower yield.',
        farmer_interpretation: 'Implement nitrogen treatment.',
        source_ids: ['E6'],
      }],
      farmer_actions: [{
        action: 'Implement the reported treatment.',
        source_ids: ['E6'],
      }],
    }, [nitrogenCoverage], [nitrogenItem]);
    expect(result.response.research_findings[0].finding).toContain('not establish');
    expect(result.response.factors[0].finding).toContain('not establish');
    expect(result.response.farmer_actions[0].action).not.toMatch(/^Implement\b/i);
  });

  // G: source mapping
  it('G: source mapping resolves E-IDs to actual source filenames', () => {
    const result = validateAndRepairStructuredResponse(response(), coverage, items);
    expect(result.response.research_findings[0].source_ids).toEqual(['paper-1.pdf']);
    expect(result.response.factors[0].source_ids).toEqual(['paper-1.pdf']);
    expect(result.invalidEvidenceIds).toEqual([]);
  });

  // H: single-call architecture
  it('H: validateAndRepairStructuredResponse is synchronous (no additional LLM calls)', () => {
    const result = validateAndRepairStructuredResponse(response(), coverage, items);
    expect(result).toBeDefined();
    expect(typeof result.response.direct_answer).toBe('string');
  });

  // I: fallback behavior
  it('I: invalid model source IDs are rejected without crashing (fallback preserved)', () => {
    const result = validateAndRepairStructuredResponse(
      response({ factors: [{ ...response().factors[0], source_ids: ['D'] }] }),
      coverage,
      items,
    );
    expect(result.invalidEvidenceIds).toContain('D');
    expect(result.response.factors[0].source_ids).toEqual([]);
  });

  // J: no duplicate text between sections
  it('J: farmer_guidance text duplicating a research_finding is filtered out', () => {
    const findingText = 'Pruning in late November increased flower yield.';
    const result = validateAndRepairStructuredResponse(
      {
        ...response(),
        research_findings: [{ factor: 'Pruning', finding: findingText, source_ids: ['E2'] }],
        farmer_guidance: [{ text: findingText, source_ids: ['E2'] }],
        factors: [],
        farmer_actions: [],
      },
      coverage,
      items,
    );
    const survived = result.response.farmer_guidance.find((g) => g.text === findingText);
    expect(survived).toBeUndefined();
  });

  // Legacy tests (preserved unchanged)

  it('resolves evidence IDs to backend source IDs (legacy factors field)', () => {
    const result = validateAndRepairStructuredResponse(response(), coverage, items);
    expect(result.response.factors[0].source_ids).toEqual(['paper-1.pdf']);
    expect(result.invalidEvidenceIds).toEqual([]);
  });

  it('rejects arbitrary model source IDs in factors', () => {
    const result = validateAndRepairStructuredResponse(
      response({ factors: [{ ...response().factors[0], source_ids: ['D'] }] }),
      coverage,
      items,
    );
    expect(result.invalidEvidenceIds).toContain('D');
    expect(result.response.factors[0].source_ids).toEqual([]);
  });

  it('detects missing nutrient management and merged factors', () => {
    const result = validateAndRepairStructuredResponse(
      response({
        factors: response().factors
          .filter((item) => item.factor !== 'Nutrient management')
          .map((item) => item.factor === 'Pruning'
            ? { ...item, factor: 'Pruning and growth regulators' }
            : item),
      }),
      coverage,
      items,
    );
    expect(result.missingCategories).toContain('Nutrient management');
    expect(result.mergedFactors).toEqual(['Pruning and growth regulators']);
  });

  it('rewrites unsafe actions and grounds nitrogen claims in legacy factors', () => {
    const nitrogenItem: GeneralEvidenceItem = {
      ...items[0],
      evidence_id: 'E6',
      category: 'Nitrogen / vegetative growth',
      source_id: 'nitrogen.pdf',
      finding: 'Nitrogen increased plant height and branches.',
      reproductive_output_supported: false,
    };
    const nitrogenCoverage: GeneralEvidenceCoverage = {
      category: nitrogenItem.category,
      classification: 'DIRECT_EVIDENCE',
      finding: nitrogenItem.finding,
      source_ids: [nitrogenItem.source_id],
      reproductive_output_supported: false,
    };
    const result = validateAndRepairStructuredResponse({
      ...response(),
      factors: [{
        factor: nitrogenItem.category,
        finding: 'Nitrogen increases flower yield.',
        farmer_interpretation: 'Implement nitrogen treatment.',
        source_ids: ['E6'],
      }],
      farmer_actions: [{
        action: 'Implement the reported treatment.',
        source_ids: ['E6'],
      }],
    }, [nitrogenCoverage], [nitrogenItem]);
    expect(result.response.factors[0].finding).toContain('not establish');
    expect(result.response.farmer_actions[0].action).not.toMatch(/^Implement\b/i);
  });

  it('removes irrelevant nitrogen warning when query and factors do not discuss nitrogen', () => {
    const result = validateAndRepairStructuredResponse(
      {
        ...response(),
        direct_answer: 'Pruning and flower-inducing treatments influence flowering.',
        research_findings: [
          {
            factor: 'Pruning',
            finding: 'Pruning in late November increased flower yield.',
            source_ids: ['E2'],
          },
        ],
        factors: [
          {
            factor: 'Pruning',
            finding: 'Pruning in late November increased flower yield.',
            farmer_interpretation: 'Compare pruning schedules locally.',
            source_ids: ['E2'],
          },
        ],
        farmer_actions: [],
        farmer_guidance: [
          {
            text: 'Compare pruning schedules locally.',
            source_ids: ['E2'],
          },
        ],
        farmer_interpretation: [
          {
            recommendation: 'Compare pruning schedules locally.',
            source_ids: ['E2'],
          },
        ],
        limitations: 'The retrieved evidence reports nitrogen effects on vegetative growth but does not establish a direct increase in flower yield.',
        caution: 'The retrieved evidence reports nitrogen effects on vegetative growth but does not establish a direct increase in flower yield.',
      },
      coverage,
      items,
      'flowering',
      'What factors influence flowering in Jasminum sambac, and how can farmers improve flower production?',
    );
    expect(result.response.limitations).not.toContain('nitrogen');
    expect(result.response.caution).not.toContain('nitrogen');
    expect(result.response.limitations).toContain('tested experimental conditions');
  });

  it('preserves nitrogen warning when nitrogen is relevant', () => {
    const result = validateAndRepairStructuredResponse(
      {
        ...response(),
        direct_answer: 'Nitrogen affects vegetative growth.',
        research_findings: [
          {
            factor: 'Nitrogen / vegetative growth',
            finding: 'Nitrogen increased vegetative shoots.',
            source_ids: ['E5'],
          },
        ],
        factors: [
          {
            factor: 'Nitrogen / vegetative growth',
            finding: 'Nitrogen increased vegetative shoots.',
            farmer_interpretation: 'Evaluate nitrogen for vegetative growth only.',
            source_ids: ['E5'],
          },
        ],
        limitations: 'The retrieved evidence reports nitrogen effects on vegetative growth but does not establish a direct increase in flower yield.',
        caution: 'The retrieved evidence reports nitrogen effects on vegetative growth but does not establish a direct increase in flower yield.',
      },
      coverage,
      items,
      'nutrition',
      'What is the effect of nitrogen?',
    );
    expect(result.response.limitations).toContain('nitrogen effects on vegetative growth');
    expect(result.response.caution).toContain('nitrogen effects on vegetative growth');
  });

  it('enforces study-specific wording for Thiourea treatments', () => {
    const result = validateAndRepairStructuredResponse(
      {
        ...response(),
        research_findings: [
          {
            factor: 'Flower-inducing treatments',
            finding: 'Apply 0.5% Thiourea along with pruning to enhance flowering.',
            source_ids: ['E1'],
          },
        ],
        factors: [
          {
            factor: 'Flower-inducing treatments',
            finding: 'Apply 0.5% Thiourea along with pruning to enhance flowering.',
            farmer_interpretation: 'Farmers can enhance flowering by applying 0.5% Thiourea along with pruning.',
            source_ids: ['E1'],
          },
        ],
        farmer_guidance: [
          {
            text: 'Farmers should apply 0.5% Thiourea along with pruning.',
            source_ids: ['E1'],
          },
        ],
        farmer_interpretation: [
          {
            recommendation: 'Farmers should apply 0.5% Thiourea along with pruning.',
            source_ids: ['E1'],
          },
        ],
        farmer_actions: [],
      },
      coverage,
      items,
      'flowering',
    );
    const expectedThiourea =
      'The retrieved study reported increased flowering when 0.5% Thiourea was combined with pruning under the tested conditions. This should be treated as a study-specific finding rather than a universal recommendation.';
    expect(result.response.factors[0].farmer_interpretation).toBe(expectedThiourea);
    expect(result.response.farmer_interpretation?.[0].recommendation).toBe(expectedThiourea);
    expect(result.response.farmer_interpretation?.[0].recommendation).not.toMatch(/Farmers (?:should|can enhance)/i);
    expect(result.response.research_findings[0].finding).toContain('tested conditions');
  });

  it('enforces study-specific wording for November pruning schedule', () => {
    const result = validateAndRepairStructuredResponse(
      {
        ...response(),
        research_findings: [
          {
            factor: 'Pruning',
            finding: 'Pruning in the last week of November maximizes yield.',
            source_ids: ['E2'],
          },
        ],
        factors: [
          {
            factor: 'Pruning',
            finding: 'Pruning in the last week of November maximizes yield.',
            farmer_interpretation: 'Farmers should consider pruning in the last week of November to maximize flower yield.',
            source_ids: ['E2'],
          },
        ],
        farmer_guidance: [
          {
            text: 'Farmers should prune in the last week of November.',
            source_ids: ['E2'],
          },
        ],
        farmer_interpretation: [
          {
            recommendation: 'Farmers should prune in the last week of November.',
            source_ids: ['E2'],
          },
        ],
        farmer_actions: [],
      },
      coverage,
      items,
      'pruning',
    );
    const expectedPruning =
      'The retrieved study reported higher flower production for the tested November pruning schedule; farmers should compare this finding with locally appropriate recommendations.';
    expect(result.response.factors[0].farmer_interpretation).toBe(expectedPruning);
    expect(result.response.farmer_interpretation?.[0].recommendation).toBe(expectedPruning);
    expect(result.response.farmer_interpretation?.[0].recommendation).not.toMatch(/Farmers should prune/i);
    expect(result.response.research_findings[0].finding).toContain('reported higher flower production');
  });

  describe('Pest query fallback & intent regression tests', () => {
    const PEST_QUERY = 'What are the major insect and mite pests of Jasminum sambac, and what are the recommended management practices?';

    it('correctly classifies canonical pest query intent as pest', () => {
      expect(detectQueryIntent(PEST_QUERY)).toBe('pest');
    });

    it('returns domain-specific insufficient evidence fallback on pest query with 0 chunks', () => {
      const fallbackStr = formatGeneralFallback([], 'Jasminum sambac', undefined, PEST_QUERY);
      const parsed: GeneralStructuredResponse = JSON.parse(fallbackStr);

      expect(parsed.query_intent).toBe('pest');
      expect(parsed.direct_answer).toBe('Insufficient pest-specific evidence was retrieved to provide a reliable management recommendation.');
      expect(parsed.research_findings).toEqual([]);
      expect(parsed.farmer_guidance).toEqual([]);
      expect(parsed.factors).toEqual([]);

      // Regression check: must NOT contain flowering/pruning/yield terms
      expect(fallbackStr).not.toMatch(/pruning|thiourea|flower yield|growth regulator|nutrient management/i);
    });

    it('filters out unrelated agronomic chunks when query intent is pest', () => {
      const agronomyChunks: GeneralChunk[] = [
        {
          chunk_id: 'chunk-1',
          category: 'pruning',
          hybrid_score: 0.9,
          text: 'Pruning in the last week of November resulted in maximum flower bud yield and shoot length in Jasminum sambac.',
          title: 'Pruning study in Jasminum sambac',
          filename: 'pruning_study.pdf',
        },
        {
          chunk_id: 'chunk-2',
          category: 'agronomy',
          hybrid_score: 0.85,
          text: 'Application of 0.5% Thiourea combined with pruning enhanced off-season flowering significantly.',
          title: 'Chemical defoliation study',
          filename: 'thiourea_study.pdf',
        },
      ];

      const fallbackStr = formatGeneralFallback(agronomyChunks, 'Jasminum sambac', undefined, PEST_QUERY);
      const parsed: GeneralStructuredResponse = JSON.parse(fallbackStr);

      // Even though agronomy chunks were provided, none are pest-related, so fallback must indicate insufficient pest evidence
      expect(parsed.query_intent).toBe('pest');
      expect(parsed.direct_answer).toBe('Insufficient pest-specific evidence was retrieved to provide a reliable management recommendation.');
      expect(parsed.research_findings).toHaveLength(0);
      expect(fallbackStr).not.toMatch(/pruning|thiourea|flower bud yield|growth regulator/i);
    });

    it('generates pest-specific findings and guidance when pest chunks are provided', () => {
      const pestChunks: GeneralChunk[] = [
        {
          chunk_id: 'pest-1',
          category: 'pest',
          hybrid_score: 0.95,
          text: 'The major pests of Jasminum sambac were budworm (Hendecasis duplifascialis), blossom midge (Contarinia maculipennis), and two-spotted spider mite. Application of biorational neem formulation significantly reduced budworm damage by 68%.',
          title: 'Evaluation of Biorational Compounds for Pest Management in Jasmine',
          filename: 'biorational_pest_study.pdf',
        },
      ];

      const fallbackStr = formatGeneralFallback(pestChunks, 'Jasminum sambac', undefined, PEST_QUERY);
      const parsed: GeneralStructuredResponse = JSON.parse(fallbackStr);

      expect(parsed.query_intent).toBe('pest');
      expect(parsed.direct_answer).toMatch(/pest/i);
      expect(parsed.research_findings.length).toBeGreaterThan(0);
      expect(parsed.research_findings[0].factor).toMatch(/budworm|pest|biorational/i);
      expect(parsed.research_findings[0].source_ids).toContain('biorational_pest_study.pdf');
      expect(parsed.farmer_guidance.length).toBeGreaterThan(0);
      expect(parsed.farmer_guidance[0].text).toMatch(/pest|monitoring|specialist/i);

      // Regression check: no flowering/pruning/yield contamination
      expect(fallbackStr).not.toMatch(/pruning|thiourea|growth regulator/i);
    });
  });

  describe('Nutrient-management evidence filtering & regression tests', () => {
    const NPK_QUERY =
      'What are the effects of nitrogen, phosphorus, potassium, and other nutrient-management practices on growth, flowering, and yield in Jasminum sambac?';
    const FLOWERING_QUERY =
      'What factors influence flowering in Jasminum sambac, and how can farmers improve flower production?';
    const IRRIGATION_QUERY =
      'What irrigation methods and scheduling practices are recommended for Jasminum sambac to improve growth and flower yield?';
    const PEST_QUERY =
      'What are the major insect and mite pests of Jasminum sambac, and what are the recommended management practices?';

    const unrelatedPruningChunks: GeneralChunk[] = [
      {
        chunk_id: 'prune-1',
        category: 'Pruning',
        hybrid_score: 0.9,
        text: 'Pruning in the last week of November resulted in maximum flower bud yield and shoot length in Jasminum sambac cv. Gundumalli.',
        title: 'Studies on pruning schedules in Jasminum sambac',
        filename: 'pruning_schedule.pdf',
      },
      {
        chunk_id: 'thiourea-1',
        category: 'Agronomy',
        hybrid_score: 0.85,
        text: 'Foliar application of 0.5% Thiourea along with defoliation significantly enhanced off-season flower induction.',
        title: 'Chemical regulation of flowering in jasmine',
        filename: 'thiourea_flowering.pdf',
      },
      {
        chunk_id: 'spacing-1',
        category: 'Cultivation',
        hybrid_score: 0.8,
        text: 'A planting density spacing of 2 x 1 m produced superior flower yield per hectare compared to wider spacing.',
        title: 'Plant population geometry in Jasminum sambac',
        filename: 'plant_density_spacing.pdf',
      },
    ];

    const validFertilizerChunks: GeneralChunk[] = [
      {
        chunk_id: 'nutr-1',
        category: 'Nutrition',
        hybrid_score: 0.95,
        text: 'Integrated nutrient management with 120:240:240 g NPK per plant along with FYM and vermicompost significantly increased flower bud yield to 4.2 kg per plant in Jasminum sambac.',
        title: 'Integrated nutrient management studies in Jasminum sambac L.',
        filename: 'inm_jasmine.pdf',
      },
    ];

    it('correctly classifies canonical NPK query intent as nutrition', () => {
      expect(detectQueryIntent(NPK_QUERY)).toBe('nutrition');
    });

    it('1. NPK query + unrelated pruning retrieval: pruning evidence is rejected, no pruning/thiourea finding appears', () => {
      const { synthesisItems } = buildRankedSynthesisEvidence(unrelatedPruningChunks, 'nutrition');
      expect(synthesisItems).toHaveLength(0);

      const fallbackStr = formatGeneralFallback(unrelatedPruningChunks, 'Jasminum sambac', undefined, NPK_QUERY);
      const parsed: GeneralStructuredResponse = JSON.parse(fallbackStr);

      expect(parsed.query_intent).toBe('nutrition');
      expect(parsed.direct_answer).toContain('does not provide sufficient nutrient-specific information');
      expect(parsed.research_findings).toHaveLength(0);
      expect(fallbackStr).not.toMatch(/thiourea|pruning schedule|planting density/i);
    });

    it('2. NPK query + valid fertilizer evidence: nutrient evidence is retained and synthesized', () => {
      const { synthesisItems } = buildRankedSynthesisEvidence(validFertilizerChunks, 'nutrition');
      expect(synthesisItems.length).toBeGreaterThan(0);
      expect(synthesisItems[0].finding).toMatch(/npk|nutrient/i);

      const fallbackStr = formatGeneralFallback(validFertilizerChunks, 'Jasminum sambac', undefined, NPK_QUERY);
      const parsed: GeneralStructuredResponse = JSON.parse(fallbackStr);

      expect(parsed.query_intent).toBe('nutrition');
      expect(parsed.research_findings.length).toBeGreaterThan(0);
      expect(parsed.research_findings[0].finding).toMatch(/120:240:240 g NPK/i);
    });

    it('3. NPK query + no nutrient evidence: returns evidence-grounded abstention', () => {
      const fallbackStr = formatGeneralFallback([], 'Jasminum sambac', undefined, NPK_QUERY);
      const parsed: GeneralStructuredResponse = JSON.parse(fallbackStr);

      expect(parsed.query_intent).toBe('nutrition');
      expect(parsed.direct_answer).toBe(
        'The retrieved evidence does not provide sufficient nutrient-specific information to reliably explain the effects of nitrogen, phosphorus, potassium, or other nutrient-management practices on growth, flowering, and yield in Jasminum sambac.',
      );
      expect(parsed.research_findings).toEqual([]);
      expect(parsed.farmer_guidance).toEqual([]);
      expect(fallbackStr).not.toMatch(/pruning|thiourea|flower yield were linked/i);
    });

    it('4. NPK query + mixed pruning, Thiourea, and density evidence: none are presented as nutrient evidence', () => {
      const mixedChunks = [...unrelatedPruningChunks, ...validFertilizerChunks];
      const { synthesisItems } = buildRankedSynthesisEvidence(mixedChunks, 'nutrition');

      // Only the fertilizer chunk should survive
      expect(synthesisItems).toHaveLength(1);
      expect(synthesisItems[0].source_id).toBe('inm_jasmine.pdf');
      expect(synthesisItems[0].finding).not.toMatch(/thiourea|november pruning|planting density/i);
    });

    it('5. Existing flowering query still returns flowering/pruning evidence', () => {
      expect(detectQueryIntent(FLOWERING_QUERY)).toBe('flowering');
      const { synthesisItems } = buildRankedSynthesisEvidence(unrelatedPruningChunks, 'flowering');
      expect(synthesisItems.length).toBeGreaterThan(0);
    });

    it('6. Existing irrigation query still returns irrigation intent without nutrient contamination', () => {
      expect(detectQueryIntent(IRRIGATION_QUERY)).toBe('irrigation');
    });

    it('7. Existing pest query still does not fall back to flowering', () => {
      expect(detectQueryIntent(PEST_QUERY)).toBe('pest');
      const fallbackStr = formatGeneralFallback([], 'Jasminum sambac', undefined, PEST_QUERY);
      expect(fallbackStr).not.toMatch(/flowering and yield were linked|thiourea|pruning/i);
    });
  });
});
