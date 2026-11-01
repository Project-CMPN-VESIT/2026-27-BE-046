/**
 * Metrics Collector for JasmineGPT Quantitative Evaluation
 * ==========================================================
 * Provides high-resolution monotonic instrumentation across retrieval,
 * LLM generation, validation, and post-processing pipeline stages.
 */

import type { EvaluationRecord } from './types';
import type { LLMCallTelemetry, SynthesisExecutionTelemetry } from '../llm/llmService';
import type { RAGGeneralResult, RAGPostHarvestResult, SourceDoc } from '../../types';

export class MetricsCollector {
  private queryId: string;
  private queryText: string;
  private category: string = 'general';
  private timestamp: string;

  private tTotalStart: bigint;
  private tPrepStart: bigint;
  private prepLatencyMs: number = 0;

  private tRetStart?: bigint;
  private tSidecarEnd?: bigint;
  private vectorRetrievalMs: number = 0;
  private relevanceFilteringMs: number = 0;
  private totalRetrievalMs: number = 0;

  // Retrieval stats
  private pipeline: 'general_faiss' | 'postharvest_hybrid' = 'general_faiss';
  private embeddingModel: string = 'BAAI/bge-small-en-v1.5';
  private scoreMetric: string = 'Cosine Similarity (FAISS IndexFlatIP)';
  private configuredTopK: number = 10;
  private actualTopK: number = 0;
  private candidateChunks: number = 0;
  private filteredChunks: number = 0;
  private selectedChunks: number = 0;
  private rejectedChunks: number = 0;
  private uniqueSources: number = 0;
  private officialSourceChunks: number | null = null;
  private scientificResearchChunks: number = 0;
  private similarityScores: number[] = [];
  private hybridMetrics?: EvaluationRecord['retrieval']['hybrid_retrieval'];

  // LLM stats
  private llmProvider: string = 'OpenRouter';
  private llmModel: string = 'openai/gpt-4o-mini';
  private llmRequestStatus: EvaluationRecord['llm']['request_status'] = 'SKIPPED_ABSTENTION';
  private apiCalls: number = 0;
  private httpStatus: number | null = null;
  private requestTimestamp: string | null = null;
  private responseTimestamp: string | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private totalTokens: number | null = null;
  private cachedTokens: number | null = null;
  private tokenUsageStatus: 'AVAILABLE' | 'UNAVAILABLE' = 'UNAVAILABLE';
  private apiLatencyMs: number = 0;
  private generationLatencyMs: number = 0;
  private parsingLatencyMs: number = 0;
  private validationLatencyMs: number = 0;
  private postProcessingLatencyMs: number = 0;

  // Deterministic validation
  private validJson: boolean = false;
  private validationPassed: boolean = false;
  private researchFindingsCount: number = 0;
  private farmerGuidanceCount: number = 0;
  private supportingEvidenceCount: number = 0;
  private uniqueCitedSourcesCount: number = 0;
  private fallbackUsed: boolean = false;
  private abstention: boolean = false;
  private apiError: boolean = false;

  constructor(queryText: string, customQueryId?: string) {
    this.queryId = customQueryId || `eval-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.queryText = queryText;
    this.timestamp = new Date().toISOString();
    this.tTotalStart = process.hrtime.bigint();
    this.tPrepStart = process.hrtime.bigint();
  }

  public getQueryId(): string {
    return this.queryId;
  }

  public setCategory(cat: string): void {
    this.category = cat;
  }

  public finishPreprocessing(): void {
    const tNow = process.hrtime.bigint();
    this.prepLatencyMs = Math.round(Number(tNow - this.tPrepStart) / 10_000) / 100;
  }

  public startRetrieval(): void {
    this.tRetStart = process.hrtime.bigint();
  }

  public recordSidecarReceived(): void {
    this.tSidecarEnd = process.hrtime.bigint();
    if (this.tRetStart) {
      this.vectorRetrievalMs = Math.round(Number(this.tSidecarEnd - this.tRetStart) / 10_000) / 100;
    }
  }

  public finishRetrieval(filteringDurationMs = 0): void {
    const tNow = process.hrtime.bigint();
    if (this.tRetStart) {
      this.totalRetrievalMs = Math.round(Number(tNow - this.tRetStart) / 10_000) / 100;
    }
    this.relevanceFilteringMs = Math.round(filteringDurationMs * 100) / 100;
  }

  public recordGeneralRAGRetrieval(
    ragResult: RAGGeneralResult,
    directChunksCount: number,
    crossChunksCount: number,
    selectedSynthesisCount: number,
  ): void {
    this.pipeline = 'general_faiss';
    this.embeddingModel = 'BAAI/bge-small-en-v1.5';
    this.scoreMetric = 'Cosine Similarity (FAISS IndexFlatIP)';
    this.configuredTopK = 10;
    this.actualTopK = selectedSynthesisCount;

    // Distinguish initial candidate pool, filtered candidate pool, and final synthesis evidence
    const sidecarCandidateCount = ragResult.retrieval_metrics?.initial_candidate_count ?? ragResult.chunks.length;
    this.candidateChunks = sidecarCandidateCount;
    this.filteredChunks = directChunksCount + crossChunksCount;
    this.selectedChunks = selectedSynthesisCount;
    this.rejectedChunks = Math.max(0, this.candidateChunks - this.filteredChunks);

    // Unique source count from candidate chunks
    const uniqueFiles = new Set<string>();
    for (const c of ragResult.chunks) {
      if (c.filename) uniqueFiles.add(c.filename);
    }
    this.uniqueSources = uniqueFiles.size;
    this.scientificResearchChunks = ragResult.chunks.length;

    // Scores
    this.similarityScores = ragResult.chunks
      .map((c) => (typeof c.score === 'number' ? Math.round(c.score * 10_000) / 10_000 : null))
      .filter((s): s is number => s !== null);
  }

  public recordPostHarvestRetrieval(ragResult: RAGPostHarvestResult): void {
    this.pipeline = 'postharvest_hybrid';
    this.embeddingModel = 'sentence-transformers/all-MiniLM-L6-v2';
    this.scoreMetric = 'Hybrid Score (0.65 * Semantic + 0.35 * TF-IDF Lexical)';
    this.configuredTopK = 8;
    this.actualTopK = ragResult.chunks.length;

    const candidatePoolCount = ragResult.retrieval_metrics?.candidate_chunks
      ?? ragResult.retrieval_metrics?.total_chunks_in_corpus
      ?? ragResult.chunks.length;
    const semanticCandidateCount = ragResult.retrieval_metrics?.semantic_candidate_count
      ?? ragResult.retrieval_metrics?.candidate_chunks
      ?? ragResult.chunks.length;
    const lexicalCandidateCount = ragResult.retrieval_metrics?.lexical_candidate_count
      ?? ragResult.retrieval_metrics?.candidate_chunks
      ?? ragResult.chunks.length;
    this.candidateChunks = candidatePoolCount;
    this.filteredChunks = ragResult.chunks.length;
    this.selectedChunks = ragResult.retrieval_metrics?.selected_chunks
      ?? Math.min(ragResult.chunks.length, 5);
    this.rejectedChunks = Math.max(0, candidatePoolCount - this.filteredChunks);
    this.uniqueSources = ragResult.documents.length;
    this.scientificResearchChunks = ragResult.chunks.length;

    this.similarityScores = ragResult.chunks
      .map((c) => Math.round(c.hybrid_score * 10_000) / 10_000);

    const semScores = ragResult.chunks
      .map((c) => c.semantic_score)
      .filter((s): s is number => typeof s === 'number')
      .map((s) => Math.round(s * 10_000) / 10_000);

    const lexScores = ragResult.chunks
      .map((c) => c.lexical_score)
      .filter((s): s is number => typeof s === 'number')
      .map((s) => Math.round(s * 10_000) / 10_000);

    this.hybridMetrics = {
      semantic_candidate_count: semanticCandidateCount,
      lexical_candidate_count: lexicalCandidateCount,
      final_hybrid_candidate_count: ragResult.chunks.length,
      semantic_scores: semScores.length > 0 ? semScores : null,
      lexical_scores: lexScores.length > 0 ? lexScores : null,
      hybrid_scores: this.similarityScores,
    };
  }

  public recordLLMTelemetry(telemetry: LLMCallTelemetry): void {
    this.llmProvider = telemetry.provider;
    this.llmModel = telemetry.model;
    this.llmRequestStatus = telemetry.requestStatus;
    this.apiCalls = telemetry.apiCalls;
    this.httpStatus = telemetry.httpStatus;
    this.requestTimestamp = telemetry.requestTimestamp;
    this.responseTimestamp = telemetry.responseTimestamp;
    this.apiLatencyMs = telemetry.apiLatencyMs;
    this.generationLatencyMs = telemetry.apiLatencyMs;
    this.inputTokens = telemetry.promptTokens;
    this.outputTokens = telemetry.completionTokens;
    this.totalTokens = telemetry.totalTokens;
    this.cachedTokens = telemetry.cachedTokens;
    this.tokenUsageStatus = telemetry.tokenUsageStatus;
    if (telemetry.requestStatus === 'FAILED') {
      this.apiError = true;
    }
  }

  public recordSynthesisTelemetry(telemetry: SynthesisExecutionTelemetry): void {
    this.recordLLMTelemetry(telemetry.llm);
    this.parsingLatencyMs = telemetry.parsingLatencyMs;
    this.validationLatencyMs = telemetry.validationLatencyMs;
    this.validJson = telemetry.validJson;
    this.validationPassed = telemetry.validationPassed;
  }

  public recordAbstention(reason?: string): void {
    this.abstention = true;
    this.llmRequestStatus = 'SKIPPED_ABSTENTION';
    this.apiCalls = 0;
    this.generationLatencyMs = 0;
    this.validJson = true;
    this.validationPassed = true;
  }

  public recordFallback(isFallback: boolean): void {
    this.fallbackUsed = isFallback;
  }

  public recordPostProcessingLatency(latencyMs: number): void {
    this.postProcessingLatencyMs = Math.round(latencyMs * 100) / 100;
  }

  public recordOutcome(
    assistantContent: string,
    sources: SourceDoc[],
    evidenceStatus: string,
  ): void {
    this.uniqueCitedSourcesCount = sources.length;

    // Deterministic validation checks
    try {
      const parsed = JSON.parse(assistantContent);
      this.validJson = true;
      if (parsed && typeof parsed === 'object') {
        const findings = Array.isArray(parsed.research_findings)
          ? parsed.research_findings
          : Array.isArray(parsed.factors)
            ? parsed.factors
            : [];
        this.researchFindingsCount = findings.length;

        const guidance = Array.isArray(parsed.farmer_guidance)
          ? parsed.farmer_guidance
          : Array.isArray(parsed.farmer_interpretation)
            ? parsed.farmer_interpretation
            : [];
        this.farmerGuidanceCount = guidance.length;

        this.supportingEvidenceCount = Array.isArray(parsed.supporting_evidence)
          ? parsed.supporting_evidence.length
          : 0;

        if (this.researchFindingsCount > 0 || this.abstention) {
          this.validationPassed = true;
        }
      }
    } catch {
      // Content is rendered markdown (e.g. post-harvest or fallback)
      this.validJson = false;
      this.validationPassed = this.fallbackUsed || this.abstention;
    }

    if (evidenceStatus === 'INSUFFICIENT_EVIDENCE' || assistantContent.includes('sufficient evidence')) {
      this.abstention = true;
    }
  }

  public buildRecord(): EvaluationRecord {
    const tTotalEnd = process.hrtime.bigint();
    const endToEndLatencyMs = Math.round(Number(tTotalEnd - this.tTotalStart) / 10_000) / 100;

    const avgSim = this.similarityScores.length > 0
      ? Math.round((this.similarityScores.reduce((a, b) => a + b, 0) / this.similarityScores.length) * 10_000) / 10_000
      : null;
    const maxSim = this.similarityScores.length > 0 ? Math.max(...this.similarityScores) : null;
    const minSim = this.similarityScores.length > 0 ? Math.min(...this.similarityScores) : null;

    return {
      query_id: this.queryId,
      timestamp: this.timestamp,
      query_text: this.queryText,
      category: this.category,
      retrieval: {
        pipeline: this.pipeline,
        embedding_model: this.embeddingModel,
        score_metric: this.scoreMetric,
        configured_top_k: this.configuredTopK,
        actual_top_k: this.actualTopK,
        candidate_chunks: this.candidateChunks,
        filtered_chunks: this.filteredChunks,
        selected_chunks: this.selectedChunks,
        rejected_chunks: this.rejectedChunks,
        unique_sources: this.uniqueSources,
        official_source_chunks: this.officialSourceChunks,
        scientific_research_chunks: this.scientificResearchChunks,
        similarity_scores: this.similarityScores,
        average_similarity: avgSim,
        max_similarity: maxSim,
        min_similarity: minSim,
        reranking_scores: null,
        average_reranking_score: null,
        query_preprocessing_latency_ms: this.prepLatencyMs,
        query_embedding_latency_ms: null,
        vector_retrieval_latency_ms: this.vectorRetrievalMs,
        relevance_filtering_latency_ms: this.relevanceFilteringMs,
        reranking_latency_ms: null,
        retrieval_latency_ms: this.totalRetrievalMs,
        hybrid_retrieval: this.hybridMetrics,
      },
      llm: {
        provider: this.llmProvider,
        model: this.llmModel,
        request_status: this.llmRequestStatus,
        api_calls: this.apiCalls,
        http_status: this.httpStatus,
        request_timestamp: this.requestTimestamp,
        response_timestamp: this.responseTimestamp,
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        total_tokens: this.totalTokens,
        cached_tokens: this.cachedTokens,
        token_usage_status: this.tokenUsageStatus,
        api_latency_ms: this.apiLatencyMs,
        generation_latency_ms: this.generationLatencyMs,
        parsing_latency_ms: this.parsingLatencyMs,
        validation_latency_ms: this.validationLatencyMs,
        post_processing_latency_ms: this.postProcessingLatencyMs,
      },
      validation: {
        valid_json: this.validJson,
        validation_passed: this.validationPassed,
        research_findings_count: this.researchFindingsCount,
        farmer_guidance_count: this.farmerGuidanceCount,
        supporting_evidence_count: this.supportingEvidenceCount,
        unique_cited_sources_count: this.uniqueCitedSourcesCount,
        fallback_used: this.fallbackUsed,
        abstention: this.abstention,
        api_error: this.apiError,
      },
      performance: {
        end_to_end_latency_ms: endToEndLatencyMs,
      },
    };
  }
}
