import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MetricsCollector } from '../services/evaluation/metricsCollector';
import {
  exportEvaluationToCsv,
  generateAggregateReport,
} from '../services/evaluation/evaluationService';
import type { EvaluationRecord } from '../services/evaluation/types';
import type { RAGGeneralResult, RAGPostHarvestResult } from '../types';

function createRecord(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    query_id: 'query-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    query_text: 'test query',
    category: 'flowering',
    retrieval: {
      pipeline: 'general_faiss',
      embedding_model: 'BAAI/bge-small-en-v1.5',
      score_metric: 'Cosine Similarity (FAISS IndexFlatIP)',
      configured_top_k: 10,
      actual_top_k: 2,
      candidate_chunks: 4,
      filtered_chunks: 3,
      selected_chunks: 2,
      rejected_chunks: 1,
      unique_sources: 2,
      official_source_chunks: null,
      scientific_research_chunks: 3,
      similarity_scores: [0.8, 0.6],
      average_similarity: 0.7,
      max_similarity: 0.8,
      min_similarity: 0.6,
      reranking_scores: null,
      average_reranking_score: null,
      query_preprocessing_latency_ms: 1,
      query_embedding_latency_ms: null,
      vector_retrieval_latency_ms: 2,
      relevance_filtering_latency_ms: 1,
      reranking_latency_ms: null,
      retrieval_latency_ms: 4,
    },
    llm: {
      provider: 'OpenRouter',
      model: 'openai/gpt-4o-mini',
      request_status: 'SUCCESS',
      api_calls: 1,
      http_status: 200,
      request_timestamp: '2026-01-01T00:00:00.000Z',
      response_timestamp: '2026-01-01T00:00:00.010Z',
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      cached_tokens: null,
      token_usage_status: 'AVAILABLE',
      api_latency_ms: 10,
      generation_latency_ms: 10,
      parsing_latency_ms: 1,
      validation_latency_ms: 1,
      post_processing_latency_ms: 1,
    },
    validation: {
      valid_json: true,
      validation_passed: true,
      research_findings_count: 1,
      farmer_guidance_count: 1,
      supporting_evidence_count: 1,
      unique_cited_sources_count: 1,
      fallback_used: false,
      abstention: false,
      api_error: false,
    },
    performance: { end_to_end_latency_ms: 20 },
    ...overrides,
  };
}

describe('MetricsCollector', () => {
  it('records retrieval counts, unique sources, and score aggregates', () => {
    const collector = new MetricsCollector('test query', 'query-1');
    collector.setCategory('flowering');
    collector.finishPreprocessing();
    collector.startRetrieval();
    collector.recordSidecarReceived();

    const ragResult: RAGGeneralResult = {
      route: 'GENERAL_RAG',
      chunks: [
        { chunk_id: '1', category: 'flowering', filename: 'a.pdf', score: 0.8, hybrid_score: 0.8, text: 'a' },
        { chunk_id: '2', category: 'flowering', filename: 'a.pdf', score: 0.6, hybrid_score: 0.6, text: 'b' },
      ],
      top_score: 0.8,
      retrieval_metrics: { initial_candidate_count: 4 },
    };
    collector.recordGeneralRAGRetrieval(ragResult, 2, 0, 2);
    collector.finishRetrieval(1.5);

    const record = collector.buildRecord();
    expect(record.retrieval.candidate_chunks).toBe(4);
    expect(record.retrieval.filtered_chunks).toBe(2);
    expect(record.retrieval.selected_chunks).toBe(2);
    expect(record.retrieval.unique_sources).toBe(1);
    expect(record.retrieval.average_similarity).toBe(0.7);
    expect(record.retrieval.min_similarity).toBe(0.6);
    expect(record.retrieval.max_similarity).toBe(0.8);
    expect(record.retrieval.retrieval_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('records provider telemetry and abstention without changing response content', () => {
    const collector = new MetricsCollector('test query', 'query-2');
    collector.recordLLMTelemetry({
      provider: 'OpenRouter',
      model: 'openai/gpt-4o-mini',
      requestStatus: 'SUCCESS',
      httpStatus: 200,
      apiCalls: 1,
      requestTimestamp: '2026-01-01T00:00:00.000Z',
      responseTimestamp: '2026-01-01T00:00:00.010Z',
      apiLatencyMs: 10,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedTokens: null,
      tokenUsageStatus: 'AVAILABLE',
    });
    collector.recordOutcome('{"research_findings":[],"farmer_guidance":[]}', [], 'INSUFFICIENT_EVIDENCE');
    collector.recordAbstention();

    const record = collector.buildRecord();
    expect(record.llm.api_calls).toBe(0);
    expect(record.llm.input_tokens).toBe(100);
    expect(record.validation.abstention).toBe(true);
    expect(record.validation.valid_json).toBe(true);
  });
});

describe('evaluation reports', () => {
  it('averages each available token field independently and exports CSV', async () => {
    const first = createRecord();
    const second = createRecord({
      query_id: 'query-2',
      llm: {
        ...first.llm,
        input_tokens: 200,
        output_tokens: null,
        total_tokens: null,
        token_usage_status: 'UNAVAILABLE',
      },
    });
    const report = generateAggregateReport([first, second]);

    expect(report.average_input_tokens).toBe(150);
    expect(report.average_output_tokens).toBe(20);
    expect(report.average_total_tokens).toBe(120);

    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jasmine-eval-'));
    const output = await exportEvaluationToCsv(
      [first],
      path.join(outputDir, 'results.csv'),
    );
    expect(output.csvContent.split('\n')).toHaveLength(2);
    expect(await fs.readFile(output.outputPath, 'utf8')).toContain('Query ID');
  });

  it('keeps fallback and abstention rates independent', () => {
    const fallback = createRecord({
      query_id: 'fallback',
      validation: {
        ...createRecord().validation,
        fallback_used: true,
        validation_passed: false,
      },
    });
    const abstention = createRecord({
      query_id: 'abstention',
      llm: { ...createRecord().llm, api_calls: 0, request_status: 'SKIPPED_ABSTENTION' },
      validation: { ...createRecord().validation, abstention: true },
    });

    const report = generateAggregateReport([fallback, abstention]);
    expect(report.fallback_rate_pct).toBe(50);
    expect(report.abstention_rate_pct).toBe(50);
  });
});
