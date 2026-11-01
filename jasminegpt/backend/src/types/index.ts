// JasmineGPT shared TypeScript types
export type RouteType = 'MEMORY_UPDATE' | 'GENERAL_RAG' | 'POSTHARVEST';

export type EvidenceStatus =
  | 'DIRECT_EVIDENCE'
  | 'MULTIPLE_STUDIES'
  | 'INSUFFICIENT_EVIDENCE'
  | 'SOURCE_REVIEW_REQUIRED'
  | 'NOT_APPLICABLE';

export type MessageRole = 'user' | 'assistant';

export interface ConversationMemory {
  species?: string | null;
  cultivar?: string | null;
  domains?: string[];
  last_route?: string | null;
  last_document_ids?: string[];
}

export interface SourceDoc {
  documentId: string;
  title: string;
  authors?: string;
  year?: number;
  doi?: string;
  page?: number;
  score?: number;
  species?: string;
  category?: string;
  isCrossSpecies?: boolean;
  crossSpeciesNote?: string;
}

export type LanguagePreference = 'auto' | 'en' | 'kn';
export type DetectedLanguage = 'en' | 'kn';

export interface ChatRequest {
  conversationId: string;
  message: string;
  languagePreference?: LanguagePreference;
}

export interface ChatResponse {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  userMessage: string;
  assistantMessage: string;
  route: RouteType;
  evidenceStatus: EvidenceStatus;
  llmCalled: boolean;
  sources: SourceDoc[];
  resolvedQuery: string;
  topScore?: number;
  detectedLanguage?: DetectedLanguage;
  targetLanguage?: 'en' | 'kn';
}

export interface RAGGeneralResult {
  route: 'GENERAL_RAG';
  chunks: GeneralChunk[];
  top_score: number;
  target_species?: string;
  category?: string;
  direct_evidence_found?: boolean;
  cross_species_used?: boolean;
  status_message?: string;
  is_multi_query?: boolean;
  sub_questions?: GeneralEvidencePacket[];
  retrieval_metrics?: {
    pipeline?: string;
    embedding_model?: string;
    score_metric?: string;
    candidate_k?: number;
    initial_candidate_count?: number;
    sub_questions_count?: number;
    embedding_latency_ms?: number;
    vector_search_latency_ms?: number;
    total_retrieval_latency_ms?: number;
  };
}

export interface GeneralEvidencePacket {
  id: string;
  question: string;
  evidence_status: 'DIRECT_EVIDENCE' | 'RELATED_EVIDENCE' | 'INSUFFICIENT_EVIDENCE';
  evidence_message: string;
  top_score: number;
  chunks: GeneralChunk[];
}

export interface GeneralChunk {
  chunk_id: string;
  category: string;
  filename: string;
  score?: number;
  hybrid_score: number;
  text: string;
  title?: string;
  author?: string;
  species?: string;
  real_species?: string;
  target_status?: string;
  is_cross_species?: boolean;
  cross_species_note?: string;
  keyword?: string;
  year?: number;
  doi?: string;
  url?: string;
  source?: string;
  page?: number;
  sub_question_id?: string;
  evidence_relation?: 'DIRECT_EVIDENCE' | 'RELATED_EVIDENCE';
}

export interface RAGPostHarvestResult {
  route_status: EvidenceStatus;
  evidence_status: EvidenceStatus;
  supported: boolean;
  llm_called: boolean;
  selected_docs: string[];
  species: string[];
  domains: string[];
  concepts: string[];
  temperatures: number[];
  question_type: string;
  documents: PostHarvestDoc[];
  chunks: PostHarvestChunk[];
  profile_facts: ProfileFact[];
  reason: string;
  evidence_message: string;
  retrieval_metrics?: {
    pipeline?: string;
    embedding_model?: string;
    score_metric?: string;
    semantic_weight?: number;
    lexical_weight?: number;
    total_chunks_in_corpus?: number;
    routed_docs_count?: number;
    semantic_candidate_count?: number;
    lexical_candidate_count?: number;
    candidate_chunks?: number;
    selected_chunks?: number;
    retrieval_latency_ms?: number;
  };
}

export interface PostHarvestDoc {
  rank: number;
  document_id: string;
  title: string;
  authors: string;
  year: number;
  doi: string;
  species: string;
  cultivar: string;
  limitations: string;
  route_reasons: string[];
}

export interface PostHarvestChunk {
  chunk_id: number;
  document_id: string;
  page: number;
  hybrid_score: number;
  semantic_score?: number;
  lexical_score?: number;
  text: string;
}

export interface ProfileFact {
  document_id: string;
  facts: string[];
}

export interface RouteResult {
  route: RouteType;
  is_profile_statement: boolean;
  is_context_dependent: boolean;
  entities: {
    species: string | null;
    cultivar: string | null;
    domains: string[];
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
