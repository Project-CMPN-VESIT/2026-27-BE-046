/**
 * Quantitative Performance Evaluation Types for JasmineGPT
 * ==========================================================
 * Rigorous schemas for measuring RAG retrieval and LLM response generation performance.
 */

export interface EvaluationRecord {
  query_id: string;
  timestamp: string; // ISO 8601
  query_text: string;
  category: string; // 'flowering' | 'irrigation' | 'pest' | 'disease' | 'nutrition' | 'post_harvest' | 'general'
  retrieval: {
    pipeline: 'general_faiss' | 'postharvest_hybrid';
    embedding_model: string;
    score_metric: string;
    configured_top_k: number;
    actual_top_k: number;
    candidate_chunks: number;
    filtered_chunks: number;
    selected_chunks: number;
    rejected_chunks: number;
    unique_sources: number;
    official_source_chunks: number | null;
    scientific_research_chunks: number;
    similarity_scores: number[];
    average_similarity: number | null;
    max_similarity: number | null;
    min_similarity: number | null;
    reranking_scores: number[] | null;
    average_reranking_score: number | null;
    query_preprocessing_latency_ms: number;
    query_embedding_latency_ms: number | null;
    vector_retrieval_latency_ms: number;
    relevance_filtering_latency_ms: number;
    reranking_latency_ms: number | null;
    retrieval_latency_ms: number;
    hybrid_retrieval?: {
      semantic_candidate_count: number | null;
      lexical_candidate_count: number | null;
      final_hybrid_candidate_count: number | null;
      semantic_scores: number[] | null;
      lexical_scores: number[] | null;
      hybrid_scores: number[] | null;
    };
  };
  llm: {
    provider: string;
    model: string;
    request_status: 'SUCCESS' | 'FAILED' | 'SKIPPED_ABSTENTION' | 'SKIPPED_NO_API_KEY';
    api_calls: number;
    http_status: number | null;
    request_timestamp: string | null;
    response_timestamp: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    cached_tokens: number | null;
    token_usage_status: 'AVAILABLE' | 'UNAVAILABLE';
    api_latency_ms: number;
    generation_latency_ms: number;
    parsing_latency_ms: number;
    validation_latency_ms: number;
    post_processing_latency_ms: number;
  };
  validation: {
    valid_json: boolean;
    validation_passed: boolean;
    research_findings_count: number;
    farmer_guidance_count: number;
    supporting_evidence_count: number;
    unique_cited_sources_count: number;
    fallback_used: boolean;
    abstention: boolean;
    api_error: boolean;
  };
  performance: {
    end_to_end_latency_ms: number;
  };
}

export interface CanonicalQueryDefinition {
  id: string;
  category: string;
  queryText: string;
  expectedRoute: 'GENERAL_RAG' | 'POSTHARVEST';
  expectedIntent: string;
  isAbstentionQuery?: boolean;
}

export interface AggregateReport {
  generated_at: string;
  total_evaluated_queries: number;
  successful_queries: number;
  failed_queries: number;

  // Monotonic latency averages (ms)
  average_retrieval_latency_ms: number;
  average_llm_generation_latency_ms: number | null;
  average_end_to_end_latency_ms: number;

  // Chunk and source averages
  average_candidate_chunks_per_query: number;
  average_filtered_chunks_per_query: number;
  average_selected_chunks_per_query: number;
  average_unique_sources_per_query: number;

  // Token consumption averages
  average_input_tokens: number | null;
  average_output_tokens: number | null;
  average_total_tokens: number | null;

  // API Call metrics
  total_openrouter_calls: number;
  average_openrouter_calls_per_query: number;

  // Deterministic rates (%)
  structured_validation_success_rate_pct: number;
  fallback_rate_pct: number;
  abstention_rate_pct: number;

  // Explanatory methodology notes
  latency_calculation_note: string;
  token_calculation_note: string;
  rates_calculation_note: string;

  // Research Paper Formatted Tables
  table1_retrieval_performance: Array<{
    query_category: string;
    candidate_chunks: number;
    selected_chunks: number;
    unique_sources: number;
    retrieval_latency_ms: number;
  }>;
  table2_generation_performance: Array<{
    query_category: string;
    input_tokens: number | string;
    output_tokens: number | string;
    api_calls: number;
    generation_latency_ms: number | string;
    validation_status: string;
  }>;
  table3_system_performance: Array<{
    metric: string;
    measured_value: string;
  }>;
}
