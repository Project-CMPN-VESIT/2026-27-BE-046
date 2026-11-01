/**
 * JasmineGPT Canonical Queries Quantitative Evaluation Runner
 * ==============================================================
 * Executes the 6 canonical benchmark queries through the full RAG & LLM
 * pipeline, logs individual runtime metrics, and generates publication tables.
 *
 * Usage:
 *   npx ts-node src/scripts/evaluateCanonicalQueries.ts
 */

import { connectDatabase, disconnectDatabase } from '../config/database';
import { checkRagHealth } from '../services/rag/ragClient';
import { executeEvaluatedTurn } from '../controllers/chatController';
import { CANONICAL_QUERIES } from '../services/evaluation/canonicalQueries';
import {
  generateAggregateReport,
  exportEvaluationToCsv,
  saveAggregateReportFiles,
  formatReportMarkdown,
} from '../services/evaluation/evaluationService';
import type { EvaluationRecord } from '../services/evaluation/types';

async function main() {
  console.log('═════════════════════════════════════════════════════════════════════');
  console.log(' JasmineGPT Quantitative Performance Evaluation — Canonical Benchmark');
  console.log('═════════════════════════════════════════════════════════════════════\n');

  console.log('Connecting to database...');
  await connectDatabase();

  console.log('Checking Python RAG sidecar health on port 8000...');
  const sidecarHealthy = await checkRagHealth();
  if (!sidecarHealthy) {
    console.warn('⚠️  Warning: Python RAG sidecar is not responding on http://localhost:8000.');
    console.warn('   Ensure the sidecar is started using `start_rag.ps1` or `uvicorn app:app`.');
  } else {
    console.log('✅ Python RAG sidecar is healthy and connected.\n');
  }

  const collectedRecords: EvaluationRecord[] = [];

  for (let i = 0; i < CANONICAL_QUERIES.length; i++) {
    const qDef = CANONICAL_QUERIES[i];
    console.log(`─────────────────────────────────────────────────────────────────────`);
    console.log(`[${i + 1}/${CANONICAL_QUERIES.length}] Evaluating ${qDef.category.toUpperCase()}`);
    console.log(`Query: "${qDef.queryText}"`);
    console.log(`Expected Route: ${qDef.expectedRoute}`);

    try {
      const { response, evaluationRecord } = await executeEvaluatedTurn(qDef.queryText, {
        queryId: qDef.id,
      });

      collectedRecords.push(evaluationRecord);

      console.log(`✔ Turn Completed.`);
      console.log(`  Retrieval: ${evaluationRecord.retrieval.pipeline} | Candidates: ${evaluationRecord.retrieval.candidate_chunks} | Filtered: ${evaluationRecord.retrieval.filtered_chunks} | Selected: ${evaluationRecord.retrieval.selected_chunks}`);
      console.log(`  Unique Sources: ${evaluationRecord.retrieval.unique_sources} | Avg Similarity: ${evaluationRecord.retrieval.average_similarity ?? 'N/A'}`);
      console.log(`  Retrieval Latency: ${evaluationRecord.retrieval.retrieval_latency_ms.toFixed(2)} ms`);
      console.log(`  LLM Provider: ${evaluationRecord.llm.provider} (${evaluationRecord.llm.model}) | Calls: ${evaluationRecord.llm.api_calls}`);
      console.log(`  Tokens: Input ${evaluationRecord.llm.input_tokens ?? 'N/A'}, Output ${evaluationRecord.llm.output_tokens ?? 'N/A'}, Total ${evaluationRecord.llm.total_tokens ?? 'N/A'}`);
      console.log(`  Generation Latency: ${evaluationRecord.llm.generation_latency_ms.toFixed(2)} ms`);
      console.log(`  Validation: ${evaluationRecord.validation.validation_passed ? 'PASSED' : 'FALLBACK'} | Abstention: ${evaluationRecord.validation.abstention}`);
      console.log(`  Total End-to-End Latency: ${evaluationRecord.performance.end_to_end_latency_ms.toFixed(2)} ms\n`);
    } catch (err) {
      console.error(`❌ Query execution failed for ${qDef.category}:`, err);
    }
  }

  console.log('═════════════════════════════════════════════════════════════════════');
  console.log(' Generating Aggregate Research Report & Publications Data');
  console.log('═════════════════════════════════════════════════════════════════════\n');

  const report = generateAggregateReport(collectedRecords);
  const { csvContent, outputPath: csvPath } = await exportEvaluationToCsv(collectedRecords);
  const filePaths = await saveAggregateReportFiles(report);

  console.log(`Output Files Saved:`);
  console.log(`- Comprehensive CSV:  ${csvPath}`);
  console.log(`- Aggregate Summary:  ${filePaths.jsonPath}`);
  console.log(`- Table 1 CSV:        ${filePaths.table1Csv}`);
  console.log(`- Table 2 CSV:        ${filePaths.table2Csv}`);
  console.log(`- Table 3 CSV:        ${filePaths.table3Csv}`);
  console.log(`- Markdown Report:    ${filePaths.markdownPath}\n`);

  console.log(formatReportMarkdown(report));

  await disconnectDatabase();
  console.log('Evaluation completed successfully.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal evaluation runner error:', err);
    process.exit(1);
  });
}
