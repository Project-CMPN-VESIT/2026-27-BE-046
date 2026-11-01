/**
 * JasmineGPT Aggregate Performance Report Generator
 * ===================================================
 * Reads stored evaluation JSON records, computes publication statistics,
 * and prints Table 1, Table 2, and Table 3.
 *
 * Usage:
 *   npx ts-node src/scripts/generateAggregateReport.ts
 */

import {
  getEvaluationRecords,
  generateAggregateReport,
  exportEvaluationToCsv,
  saveAggregateReportFiles,
  formatReportMarkdown,
} from '../services/evaluation/evaluationService';

async function main() {
  console.log('Reading stored evaluation records...');
  const records = await getEvaluationRecords();

  if (records.length === 0) {
    console.log('No evaluation records found. Run `npm run eval:canonical` to collect benchmark data.');
    return;
  }

  console.log(`Found ${records.length} evaluation records. Generating statistical analysis...\n`);
  const report = generateAggregateReport(records);
  const { outputPath: csvPath } = await exportEvaluationToCsv(records);
  const filePaths = await saveAggregateReportFiles(report);

  console.log(formatReportMarkdown(report));
  console.log('\nReport generation complete. Export locations:');
  console.log(`- CSV:  ${csvPath}`);
  console.log(`- JSON: ${filePaths.jsonPath}`);
  console.log(`- MD:   ${filePaths.markdownPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Report generator error:', err);
    process.exit(1);
  });
}
