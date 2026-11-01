/**
 * Canonical Research Evaluation Queries for JasmineGPT
 * =======================================================
 * The six standardized benchmark queries representing key agronomic domains
 * in jasmine floriculture, used for research evaluation.
 */

import type { CanonicalQueryDefinition } from './types';

export const CANONICAL_QUERIES: CanonicalQueryDefinition[] = [
  {
    id: 'Q1_FLOWERING',
    category: 'flowering',
    queryText: 'What factors influence flowering in Jasminum sambac, and how can farmers improve flower production?',
    expectedRoute: 'GENERAL_RAG',
    expectedIntent: 'flowering',
  },
  {
    id: 'Q2_IRRIGATION',
    category: 'irrigation',
    queryText: 'What irrigation methods and scheduling practices are recommended for Jasminum sambac to improve growth and flower yield?',
    expectedRoute: 'GENERAL_RAG',
    expectedIntent: 'irrigation',
  },
  {
    id: 'Q3_PEST',
    category: 'pest',
    queryText: 'What are the major insect and mite pests of Jasminum sambac, and what are the recommended management practices?',
    expectedRoute: 'GENERAL_RAG',
    expectedIntent: 'pest',
  },
  {
    id: 'Q4_DISEASE',
    category: 'disease',
    queryText: 'What are the major diseases of Jasminum sambac, and what are their symptoms, causes, and management practices?',
    expectedRoute: 'GENERAL_RAG',
    expectedIntent: 'disease',
  },
  {
    id: 'Q5_NUTRIENT_MANAGEMENT',
    category: 'nutrition',
    queryText: 'What are the effects of nitrogen, phosphorus, potassium, and other nutrient-management practices on growth, flowering, and yield in Jasminum sambac?',
    expectedRoute: 'GENERAL_RAG',
    expectedIntent: 'nutrition',
    isAbstentionQuery: true,
  },
  {
    id: 'Q6_POST_HARVEST',
    category: 'post_harvest',
    queryText: 'What post-harvest practices are recommended for handling, packaging, storage, and preservation of Jasminum sambac flowers?',
    expectedRoute: 'POSTHARVEST',
    expectedIntent: 'post_harvest',
  },
];
