const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
const API_PREFIX = '/api/official-agricultural';

export interface OfficialSource {
  page_url: string;
  source_name?: string;
  page_title?: string;
  section?: string;
  category?: string;
  score_percent?: number;
  is_deep_url?: boolean | string;
}

export interface OfficialRetrievalResponse {
  answer?: string;
  sources?: OfficialSource[];
  query_understanding?: {
    category?: string;
    location?: string;
  };
  answer_mode?: string;
  from_cache?: boolean;
  rag_evidence?: Array<{
    chunk_id?: string;
    title?: string;
    filename?: string;
    text?: string;
    source?: string;
    score?: number;
    species?: string;
    category?: string;
    year?: number;
    key_points?: string[];
    is_cross_species?: boolean;
  }>;
}

export interface OfficialDatabaseStatus {
  page_count?: number;
  chunk_count?: number;
  chroma_vectors?: number;
  last_successful_run?: string | null;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${API_PREFIX}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.detail ?? `Official retrieval request failed: ${response.status}`);
  }
  return body as T;
}

export const officialAgriculturalApi = {
  getDatabaseStatus: (): Promise<OfficialDatabaseStatus> =>
    request('/db-status'),

  ask: (message: string): Promise<OfficialRetrievalResponse> =>
    request('/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  triggerDeepSearch: (): Promise<{
    triggered?: boolean;
    message?: string;
    reason?: string;
    next_allowed_run?: string;
  }> => request('/deep-search', { method: 'POST' }),
};
