/**
 * Quantitative Performance Evaluation Service for JasmineGPT
 * =============================================================
 * Handles data collection, JSON logging, CSV export, and statistical
 * aggregation for academic research papers.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EvaluationRecord, AggregateReport } from './types';
import { logger } from '../../utils/logger';

export function getEvaluationPaths() {
  const baseDir = process.env.EVAL_DIR
    ? path.resolve(process.env.EVAL_DIR)
    : path.resolve(process.cwd(), '../../evaluation');
  const logsDir = path.join(baseDir, 'logs');
  const reportsDir = path.join(baseDir, 'reports');

  return { baseDir, logsDir, reportsDir };
}

export function ensureDirectories(): { baseDir: string; logsDir: string; reportsDir: string } {
  const paths = getEvaluationPaths();
  if (!fs.existsSync(paths.logsDir)) {
    fs.mkdirSync(paths.logsDir, { recursive: true });
  }
  if (!fs.existsSync(paths.reportsDir)) {
    fs.mkdirSync(paths.reportsDir, { recursive: true });
  }
  return paths;
}

/**
 * Sanitizes any sensitive string data to prevent credentials from ever being written to logs.
 */
function sanitizeRecord(record: EvaluationRecord): EvaluationRecord {
  const copy: EvaluationRecord = JSON.parse(JSON.stringify(record));
  // Ensure query_id has no sensitive patterns
  copy.query_id = copy.query_id.replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]');
  return copy;
}

/**
 * Persist an individual query evaluation record to a structured JSON file.
 */
export async function recordEvaluation(record: EvaluationRecord): Promise<string> {
  const { logsDir } = ensureDirectories();
  const sanitized = sanitizeRecord(record);

  const safeCategory = record.category.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestampStr = new Date(record.timestamp).toISOString().replace(/[:.]/g, '-');
  const shortId = record.query_id.replace(/[^a-zA-Z0-9_-]/g, '').slice(-8);
  const filename = `eval_${safeCategory}_${timestampStr}_${shortId}.json`;
  const filePath = path.join(logsDir, filename);

  await fs.promises.writeFile(filePath, JSON.stringify(sanitized, null, 2), 'utf-8');
  logger.info({ filePath, queryId: record.query_id, category: record.category }, 'Evaluation record persisted');
  return filePath;
}

/**
 * Load all recorded evaluation JSON files from the log directory.
 */
export async function getEvaluationRecords(customLogsDir?: string): Promise<EvaluationRecord[]> {
  const logsDir = customLogsDir || getEvaluationPaths().logsDir;
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  const files = await fs.promises.readdir(logsDir);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  const records: EvaluationRecord[] = [];
  for (const file of jsonFiles) {
    try {
      const fullPath = path.join(logsDir, file);
      const content = await fs.promises.readFile(fullPath, 'utf-8');
      const parsed = JSON.parse(content) as EvaluationRecord;
      if (parsed && parsed.query_id && parsed.retrieval && parsed.llm) {
        records.push(parsed);
      }
    } catch (err) {
      logger.warn({ file, err }, 'Failed to parse evaluation log file');
    }
  }

  // Sort chronologically
  return records.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

/**
 * Clean a string for CSV formatting by escaping quotes and newlines.
 */
function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/"/g, '""').replace(/[\r\n]+/g, ' ');
  return `"${str}"`;
}

/**
 * Export collected evaluation records into a comprehensive flat CSV.
 */
export async function exportEvaluationToCsv(
  records: EvaluationRecord[],
  customOutputPath?: string,
): Promise<{ csvContent: string; outputPath: string }> {
  const { reportsDir } = ensureDirectories();
  const outputPath = customOutputPath || path.join(reportsDir, 'evaluation_results.csv');

  const headers = [
    'Query ID',
    'Timestamp',
    'Category',
    'Query Text',
    'Pipeline',
    'Embedding Model',
    'Score Metric',
    'Configured Top-K',
    'Actual Top-K',
    'Candidate Chunks',
    'Filtered Chunks',
    'Selected Chunks',
    'Rejected Chunks',
    'Unique Sources',
    'Official Source Chunks',
    'Scientific Research Chunks',
    'Average Similarity',
    'Min Similarity',
    'Max Similarity',
    'Query Preprocessing Latency (ms)',
    'Vector Retrieval Latency (ms)',
    'Relevance Filtering Latency (ms)',
    'Total Retrieval Latency (ms)',
    'LLM Provider',
    'LLM Model',
    'LLM Request Status',
    'API Calls',
    'HTTP Status',
    'Input Tokens',
    'Output Tokens',
    'Total Tokens',
    'Cached Tokens',
    'Token Status',
    'API Latency (ms)',
    'Generation Latency (ms)',
    'Parsing Latency (ms)',
    'Validation Latency (ms)',
    'Post-Processing Latency (ms)',
    'Valid JSON',
    'Validation Passed',
    'Research Findings Count',
    'Farmer Guidance Count',
    'Supporting Evidence Count',
    'Unique Cited Sources',
    'Fallback Used',
    'Abstention',
    'API Error',
    'End-to-End Latency (ms)',
  ];

  const rows = records.map((r) => [
    escapeCsv(r.query_id),
    escapeCsv(r.timestamp),
    escapeCsv(r.category),
    escapeCsv(r.query_text),
    escapeCsv(r.retrieval.pipeline),
    escapeCsv(r.retrieval.embedding_model),
    escapeCsv(r.retrieval.score_metric),
    r.retrieval.configured_top_k,
    r.retrieval.actual_top_k,
    r.retrieval.candidate_chunks,
    r.retrieval.filtered_chunks,
    r.retrieval.selected_chunks,
    r.retrieval.rejected_chunks,
    r.retrieval.unique_sources,
    r.retrieval.official_source_chunks ?? 'N/A',
    r.retrieval.scientific_research_chunks,
    r.retrieval.average_similarity ?? 'N/A',
    r.retrieval.min_similarity ?? 'N/A',
    r.retrieval.max_similarity ?? 'N/A',
    r.retrieval.query_preprocessing_latency_ms,
    r.retrieval.vector_retrieval_latency_ms,
    r.retrieval.relevance_filtering_latency_ms,
    r.retrieval.retrieval_latency_ms,
    escapeCsv(r.llm.provider),
    escapeCsv(r.llm.model),
    escapeCsv(r.llm.request_status),
    r.llm.api_calls,
    r.llm.http_status ?? 'N/A',
    r.llm.input_tokens ?? 'N/A',
    r.llm.output_tokens ?? 'N/A',
    r.llm.total_tokens ?? 'N/A',
    r.llm.cached_tokens ?? 'N/A',
    escapeCsv(r.llm.token_usage_status),
    r.llm.api_latency_ms,
    r.llm.generation_latency_ms,
    r.llm.parsing_latency_ms,
    r.llm.validation_latency_ms,
    r.llm.post_processing_latency_ms,
    r.validation.valid_json,
    r.validation.validation_passed,
    r.validation.research_findings_count,
    r.validation.farmer_guidance_count,
    r.validation.supporting_evidence_count,
    r.validation.unique_cited_sources_count,
    r.validation.fallback_used,
    r.validation.abstention,
    r.validation.api_error,
    r.performance.end_to_end_latency_ms,
  ]);

  const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
  await fs.promises.writeFile(outputPath, csvContent, 'utf-8');
  return { csvContent, outputPath };
}

/**
 * Generate aggregate performance statistics adhering strictly to Section 7 & 11 research guidelines.
 */
export function generateAggregateReport(records: EvaluationRecord[]): AggregateReport {
  const total = records.length;
  if (total === 0) {
    return {
      generated_at: new Date().toISOString(),
      total_evaluated_queries: 0,
      successful_queries: 0,
      failed_queries: 0,
      average_retrieval_latency_ms: 0,
      average_llm_generation_latency_ms: null,
      average_end_to_end_latency_ms: 0,
      average_candidate_chunks_per_query: 0,
      average_filtered_chunks_per_query: 0,
      average_selected_chunks_per_query: 0,
      average_unique_sources_per_query: 0,
      average_input_tokens: null,
      average_output_tokens: null,
      average_total_tokens: null,
      total_openrouter_calls: 0,
      average_openrouter_calls_per_query: 0,
      structured_validation_success_rate_pct: 0,
      fallback_rate_pct: 0,
      abstention_rate_pct: 0,
      latency_calculation_note: 'No records evaluated.',
      token_calculation_note: 'No records evaluated.',
      rates_calculation_note: 'No records evaluated.',
      table1_retrieval_performance: [],
      table2_generation_performance: [],
      table3_system_performance: [],
    };
  }

  const successfulQueries = records.filter((r) => !r.validation.api_error);
  const failedQueries = records.filter((r) => r.validation.api_error);

  // Latency averages
  const validRetrieval = records.filter((r) => typeof r.retrieval.retrieval_latency_ms === 'number');
  const avgRetrievalLatency = validRetrieval.length > 0
    ? validRetrieval.reduce((acc, r) => acc + r.retrieval.retrieval_latency_ms, 0) / validRetrieval.length
    : 0;

  const validGeneration = records.filter((r) => r.llm.api_calls > 0 && r.llm.generation_latency_ms > 0);
  const avgGenerationLatency = validGeneration.length > 0
    ? validGeneration.reduce((acc, r) => acc + r.llm.generation_latency_ms, 0) / validGeneration.length
    : null;

  const avgEndToEndLatency = records.reduce((acc, r) => acc + r.performance.end_to_end_latency_ms, 0) / total;

  // Chunk and source averages
  const avgCandidateChunks = records.reduce((acc, r) => acc + r.retrieval.candidate_chunks, 0) / total;
  const avgFilteredChunks = records.reduce((acc, r) => acc + r.retrieval.filtered_chunks, 0) / total;
  const avgSelectedChunks = records.reduce((acc, r) => acc + r.retrieval.selected_chunks, 0) / total;
  const avgUniqueSources = records.reduce((acc, r) => acc + r.retrieval.unique_sources, 0) / total;

  // Token averages (only valid provider-reported numbers)
  const inputTokenRecords = records.filter((r) => typeof r.llm.input_tokens === 'number');
  const outputTokenRecords = records.filter((r) => typeof r.llm.output_tokens === 'number');
  const totalTokenRecords = records.filter((r) => typeof r.llm.total_tokens === 'number');
  const avgInputTokens = inputTokenRecords.length > 0
    ? inputTokenRecords.reduce((acc, r) => acc + (r.llm.input_tokens as number), 0) / inputTokenRecords.length
    : null;
  const avgOutputTokens = outputTokenRecords.length > 0
    ? outputTokenRecords.reduce((acc, r) => acc + (r.llm.output_tokens as number), 0) / outputTokenRecords.length
    : null;
  const avgTotalTokens = totalTokenRecords.length > 0
    ? totalTokenRecords.reduce((acc, r) => acc + (r.llm.total_tokens as number), 0) / totalTokenRecords.length
    : null;

  // API Call metrics
  const totalOpenRouterCalls = records.reduce((acc, r) => acc + r.llm.api_calls, 0);
  const avgOpenRouterCalls = totalOpenRouterCalls / total;

  // Deterministic rates:
  // Validation success rate = (Valid structured responses / Eligible responses) * 100
  // Eligible responses are queries where LLM synthesis was executed (excluding abstentions where LLM is intentionally not called)
  const eligibleForValidation = records.filter((r) => r.llm.api_calls > 0);
  const validStructuredResponses = eligibleForValidation.filter((r) => r.validation.valid_json && r.validation.validation_passed);
  const validationSuccessRatePct = eligibleForValidation.length > 0
    ? (validStructuredResponses.length / eligibleForValidation.length) * 100
    : 100;

  // Fallback rate = (Queries using fallback / Total queries) * 100
  const fallbackQueries = records.filter((r) => r.validation.fallback_used);
  const fallbackRatePct = (fallbackQueries.length / total) * 100;

  // Abstention rate = (Queries returning insufficient-evidence abstention / Total queries) * 100
  const abstentionQueries = records.filter((r) => r.validation.abstention);
  const abstentionRatePct = (abstentionQueries.length / total) * 100;

  // ── TABLE 1: Query-wise RAG Retrieval Performance ─────────────────────────
  const table1 = records.map((r) => ({
    query_category: r.category,
    candidate_chunks: r.retrieval.candidate_chunks,
    selected_chunks: r.retrieval.selected_chunks,
    unique_sources: r.retrieval.unique_sources,
    retrieval_latency_ms: Math.round(r.retrieval.retrieval_latency_ms * 100) / 100,
  }));

  // ── TABLE 2: LLM Response Generation Performance ──────────────────────────
  const table2 = records.map((r) => ({
    query_category: r.category,
    input_tokens: r.llm.input_tokens !== null ? r.llm.input_tokens : 'N/A',
    output_tokens: r.llm.output_tokens !== null ? r.llm.output_tokens : 'N/A',
    api_calls: r.llm.api_calls,
    generation_latency_ms: r.llm.generation_latency_ms > 0
      ? Math.round(r.llm.generation_latency_ms * 100) / 100
      : (r.validation.abstention ? 'Abstained (0.00)' : 'N/A'),
    validation_status: r.validation.abstention
      ? 'Abstained (Evidence-Aware)'
      : (r.validation.validation_passed ? 'Passed (Valid JSON)' : 'Fallback Used'),
  }));

  // ── TABLE 3: Overall System Performance ────────────────────────────────────
  const table3 = [
    { metric: 'Total Evaluated Queries', measured_value: `${total}` },
    { metric: 'Average Retrieval Latency (ms)', measured_value: `${Math.round(avgRetrievalLatency * 100) / 100} ms` },
    { metric: 'Average LLM Generation Latency (ms)', measured_value: avgGenerationLatency !== null ? `${Math.round(avgGenerationLatency * 100) / 100} ms` : 'N/A (No LLM calls)' },
    { metric: 'Average End-to-End Latency (ms)', measured_value: `${Math.round(avgEndToEndLatency * 100) / 100} ms` },
    { metric: 'Average Candidate Chunks per Query', measured_value: `${Math.round(avgCandidateChunks * 10) / 10}` },
    { metric: 'Average Filtered Chunks per Query', measured_value: `${Math.round(avgFilteredChunks * 10) / 10}` },
    { metric: 'Average Selected Chunks per Query', measured_value: `${Math.round(avgSelectedChunks * 10) / 10}` },
    { metric: 'Average Unique Sources per Query', measured_value: `${Math.round(avgUniqueSources * 10) / 10}` },
    { metric: 'Average Input Tokens per Query', measured_value: avgInputTokens !== null ? `${Math.round(avgInputTokens)}` : 'N/A' },
    { metric: 'Average Output Tokens per Query', measured_value: avgOutputTokens !== null ? `${Math.round(avgOutputTokens)}` : 'N/A' },
    { metric: 'Average Total Tokens per Query', measured_value: avgTotalTokens !== null ? `${Math.round(avgTotalTokens)}` : 'N/A' },
    { metric: 'Total OpenRouter Calls Made', measured_value: `${totalOpenRouterCalls}` },
    { metric: 'Average OpenRouter Calls per Query', measured_value: `${Math.round(avgOpenRouterCalls * 100) / 100}` },
    { metric: 'Structured Response Validation Success Rate', measured_value: `${Math.round(validationSuccessRatePct * 10) / 10}%` },
    { metric: 'Deterministic Fallback Rate', measured_value: `${Math.round(fallbackRatePct * 10) / 10}%` },
    { metric: 'Evidence-Aware Abstention Rate', measured_value: `${Math.round(abstentionRatePct * 10) / 10}%` },
  ];

  return {
    generated_at: new Date().toISOString(),
    total_evaluated_queries: total,
    successful_queries: successfulQueries.length,
    failed_queries: failedQueries.length,
    average_retrieval_latency_ms: Math.round(avgRetrievalLatency * 100) / 100,
    average_llm_generation_latency_ms: avgGenerationLatency !== null ? Math.round(avgGenerationLatency * 100) / 100 : null,
    average_end_to_end_latency_ms: Math.round(avgEndToEndLatency * 100) / 100,
    average_candidate_chunks_per_query: Math.round(avgCandidateChunks * 100) / 100,
    average_filtered_chunks_per_query: Math.round(avgFilteredChunks * 100) / 100,
    average_selected_chunks_per_query: Math.round(avgSelectedChunks * 100) / 100,
    average_unique_sources_per_query: Math.round(avgUniqueSources * 100) / 100,
    average_input_tokens: avgInputTokens !== null ? Math.round(avgInputTokens * 10) / 10 : null,
    average_output_tokens: avgOutputTokens !== null ? Math.round(avgOutputTokens * 10) / 10 : null,
    average_total_tokens: avgTotalTokens !== null ? Math.round(avgTotalTokens * 10) / 10 : null,
    total_openrouter_calls: totalOpenRouterCalls,
    average_openrouter_calls_per_query: Math.round(avgOpenRouterCalls * 100) / 100,
    structured_validation_success_rate_pct: Math.round(validationSuccessRatePct * 10) / 10,
    fallback_rate_pct: Math.round(fallbackRatePct * 10) / 10,
    abstention_rate_pct: Math.round(abstentionRatePct * 10) / 10,
    latency_calculation_note: 'Averages calculated over valid monotonic runtime measurements. Failed API attempts and abstained generation phases are excluded from generation latency averages.',
    token_calculation_note: 'Token consumption reflects actual OpenRouter response usage. Queries where API was not called (e.g. evidence abstention) are excluded from token averages.',
    rates_calculation_note: 'Validation success rate reflects eligible responses synthesized by the LLM. Fallback and abstention rates are evaluated independently across all queries.',
    table1_retrieval_performance: table1,
    table2_generation_performance: table2,
    table3_system_performance: table3,
  };
}

/**
 * Format markdown research tables suitable for publication or terminal output.
 */
export function formatReportMarkdown(report: AggregateReport): string {
  const lines: string[] = [];

  lines.push('# JasmineGPT Quantitative Performance Evaluation Report');
  lines.push(`Generated: ${report.generated_at}\n`);
  lines.push(`Total Evaluated Queries: ${report.total_evaluated_queries} | Successful: ${report.successful_queries} | Failed: ${report.failed_queries}\n`);

  lines.push('## TABLE 1 — Query-wise RAG Retrieval Performance');
  lines.push('| Query Category | Candidate Chunks | Selected Chunks | Unique Sources | Retrieval Latency (ms) |');
  lines.push('| :--- | :---: | :---: | :---: | :---: |');
  for (const row of report.table1_retrieval_performance) {
    lines.push(`| ${row.query_category} | ${row.candidate_chunks} | ${row.selected_chunks} | ${row.unique_sources} | ${row.retrieval_latency_ms.toFixed(2)} |`);
  }
  lines.push('');

  lines.push('## TABLE 2 — LLM Response Generation Performance');
  lines.push('| Query Category | Input Tokens | Output Tokens | API Calls | Generation Latency (ms) | Validation Status |');
  lines.push('| :--- | :---: | :---: | :---: | :---: | :--- |');
  for (const row of report.table2_generation_performance) {
    lines.push(`| ${row.query_category} | ${row.input_tokens} | ${row.output_tokens} | ${row.api_calls} | ${row.generation_latency_ms} | ${row.validation_status} |`);
  }
  lines.push('');

  lines.push('## TABLE 3 — Overall System Performance');
  lines.push('| Metric | Measured Value |');
  lines.push('| :--- | :---: |');
  for (const row of report.table3_system_performance) {
    lines.push(`| ${row.metric} | ${row.measured_value} |`);
  }
  lines.push('');

  lines.push('### Notes on Methodology');
  lines.push(`- **Latency Calculation**: ${report.latency_calculation_note}`);
  lines.push(`- **Token Consumption**: ${report.token_calculation_note}`);
  lines.push(`- **Validation & Reliability**: ${report.rates_calculation_note}`);

  return lines.join('\n');
}

/**
 * Save aggregate report to disk as JSON and tables as individual CSVs.
 */
export async function saveAggregateReportFiles(
  report: AggregateReport,
  customReportsDir?: string,
): Promise<{ jsonPath: string; table1Csv: string; table2Csv: string; table3Csv: string; markdownPath: string }> {
  const reportsDir = customReportsDir || getEvaluationPaths().reportsDir;
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const jsonPath = path.join(reportsDir, 'aggregate_summary.json');
  await fs.promises.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  // Table 1 CSV
  const table1Csv = path.join(reportsDir, 'table1_retrieval_performance.csv');
  const t1Headers = ['Query Category', 'Candidate Chunks', 'Selected Chunks', 'Unique Sources', 'Retrieval Latency (ms)'];
  const t1Rows = report.table1_retrieval_performance.map((r) =>
    [escapeCsv(r.query_category), r.candidate_chunks, r.selected_chunks, r.unique_sources, r.retrieval_latency_ms].join(','),
  );
  await fs.promises.writeFile(table1Csv, [t1Headers.join(','), ...t1Rows].join('\n'), 'utf-8');

  // Table 2 CSV
  const table2Csv = path.join(reportsDir, 'table2_generation_performance.csv');
  const t2Headers = ['Query Category', 'Input Tokens', 'Output Tokens', 'API Calls', 'Generation Latency (ms)', 'Validation Status'];
  const t2Rows = report.table2_generation_performance.map((r) =>
    [escapeCsv(r.query_category), r.input_tokens, r.output_tokens, r.api_calls, r.generation_latency_ms, escapeCsv(r.validation_status)].join(','),
  );
  await fs.promises.writeFile(table2Csv, [t2Headers.join(','), ...t2Rows].join('\n'), 'utf-8');

  // Table 3 CSV
  const table3Csv = path.join(reportsDir, 'table3_system_performance.csv');
  const t3Headers = ['Metric', 'Measured Value'];
  const t3Rows = report.table3_system_performance.map((r) =>
    [escapeCsv(r.metric), escapeCsv(r.measured_value)].join(','),
  );
  await fs.promises.writeFile(table3Csv, [t3Headers.join(','), ...t3Rows].join('\n'), 'utf-8');

  // Markdown Report
  const markdownPath = path.join(reportsDir, 'evaluation_report.md');
  await fs.promises.writeFile(markdownPath, formatReportMarkdown(report), 'utf-8');

  return { jsonPath, table1Csv, table2Csv, table3Csv, markdownPath };
}
