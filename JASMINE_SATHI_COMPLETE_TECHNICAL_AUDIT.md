# JasmineSathi / JasmineGPT Complete Technical Audit

**Audit date:** 2026-10-05  
**Scope:** Existing repository source, checked-in data artifacts, manifests, README files, notebooks, and tests.  
**Change policy:** No project source files, data files, notebooks, or configuration files were modified. Secret values were not inspected or reproduced.

## Status Vocabulary

| Status | Meaning |
|---|---|
| **Active runtime** | Reached by the current frontend/backend/service path. |
| **Implemented but not reached by normal runtime path** | Present in source but not called by the current application flow. |
| **Configured but not used** | A variable/path/field is declared but the active code does not consume it. |
| **Legacy/experimental** | Notebook, backup artifact, generated output, or older implementation not authoritative for the current path. |
| **NOT VERIFIED** | The repository does not establish the claim. |

## 1. Executive Summary

The repository implements a React/Vite frontend, an Express/TypeScript backend, and a Python/FastAPI RAG sidecar. The current runtime uses MongoDB for conversations/messages, a persisted FAISS `IndexFlatIP` index for general Jasmine retrieval, an in-memory hybrid semantic/TF-IDF collection for post-harvest retrieval, Sentence Transformers for embeddings, and OpenRouter for optional final LLM synthesis.

The current runtime is materially different from the root [README.md](README.md) technology table, which says ChromaDB, LangChain, and Gemini. Those technologies are not evidenced in the active source path. The current backend configuration defaults to `openai/gpt-4o-mini` through OpenRouter.

The target user is represented as a jasmine farmer. The code explicitly supports `Jasminum sambac` and `Jasminum auriculatum` in species logic, with other species present in the general corpus as comparative or excluded records. The repository does not establish a target geography for the application as a whole. Some source metadata and README examples reference India, Tamil Nadu, Karnataka, and related agricultural institutions, but a single deployment geography is **NOT VERIFIED**.

### Runtime architecture

```text
Browser React UI
  -> fetch() /api/chat or /api/conversations
  -> Express app (backend/src/app.ts)
  -> handleChat() (chatController.ts)
  -> language detection and optional Kannada-to-English normalization
  -> MongoDB conversation/memory/recent-turn reads
  -> deterministic follow-up resolution
  -> routeQuestion(): MEMORY_UPDATE | GENERAL_RAG | POSTHARVEST
  -> Python FastAPI sidecar (/rag/general or /rag/postharvest)
       GENERAL_RAG:
         BAAI/bge-small-en-v1.5
         normalized query vector
         FAISS IndexFlatIP search
         CSV row mapping by vector ID
         species/category filtering
       POSTHARVEST:
         five verified profiles
         all-MiniLM-L6-v2 semantic score
         TF-IDF lexical score
         weighted hybrid ranking
  -> topic/species/evidence filtering in Node
  -> prompt construction
  -> optional OpenRouter callLLM()
  -> fallback formatted evidence when no key or LLM failure
  -> citation/source reconciliation
  -> optional final Kannada translation
  -> MongoDB persistence
  -> JSON response to frontend
```

## 2. Project Inventory

The repository root contains the `jasminegpt` application, one phase notebook, and README files. The source inventory previously checked for the repository excludes dependency directories and generated build output when counting implementation files.

| Area | Observed implementation |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind/PostCSS configuration, `src/` components/hooks/pages |
| Backend | Express 4, TypeScript, Mongoose, Axios, Zod, Helmet, CORS, Pino |
| Python service | FastAPI, Uvicorn, pandas, NumPy, FAISS, Sentence Transformers, scikit-learn |
| Data artifacts | `general_chunks.csv`, `chunk_metadata.csv`, `metadata.csv`, `general_faiss.index`, backups |
| Notebooks | Root phase notebook; `jasminegpt/try.ipynb`; notebook-derived post-harvest references in source comments |
| Tests | Backend Jest tests; Python routing/RAG tests and startup scripts |
| Docker | No Dockerfile or compose deployment was found |
| Python packaging | `requirements.txt`; no `pyproject.toml` found |
| Authentication | No authentication implementation found |
| Government schemes | No runtime scheme module or endpoint verified |
| Evaluation | No implemented Hit@5/Q1-Q5 evaluation pipeline verified |

## 3. Actual Request Flow

### 3.1 Frontend

**Evidence:** [frontend/src/services/api.ts](jasminegpt/frontend/src/services/api.ts), `api.sendMessage()`, `request()`.

The frontend uses the Vite variable `VITE_API_BASE_URL`, defaulting to `http://localhost:4000`. It sends:

```http
POST /api/chat
Content-Type: application/json

{
  "conversationId": "...",
  "message": "...",
  "languagePreference": "en" | "kn" | undefined
}
```

`useChat()` in [frontend/src/hooks/useChat.ts](jasminegpt/frontend/src/hooks/useChat.ts) performs optimistic user-message display, calls the API, replaces the temporary message, adds the assistant response, loads conversation history, and exposes sending/error state.

`App.tsx` renders `ChatPage`. The checked-in frontend is a chat interface with conversation components, evidence/source display components, language selection, farmer profile hook, and speech-recognition hook. No separate government-scheme page or verified scheme API call was found.

### 3.2 Backend API

**Evidence:** [backend/src/app.ts](jasminegpt/backend/src/app.ts), [backend/src/server.ts](jasminegpt/backend/src/server.ts).

| Endpoint | Method | File/function | Purpose |
|---|---:|---|---|
| `/health` | GET | `app.ts` inline handler | Backend health response |
| `/api/conversations` | POST | conversation route/controller | Create conversation |
| `/api/conversations` | GET | conversation route/controller | List conversations |
| `/api/conversations/:id` | GET | conversation route/controller | Get conversation |
| `/api/conversations/:id` | PATCH | conversation route/controller | Update title |
| `/api/conversations/:id` | DELETE | conversation route/controller | Delete conversation/messages |
| `/api/conversations/:id/messages` | GET | conversation route/controller | Get stored messages |
| `/api/chat` | POST | `handleChat()` in `chatController.ts` | Main JasmineGPT request path |

`server.ts` connects MongoDB before listening. The default backend port is 4000.

### 3.3 Query preprocessing and routing

**Evidence:** [backend/src/controllers/chatController.ts](jasminegpt/backend/src/controllers/chatController.ts), `handleChat()`; [backend/src/services/language/languageService.ts](jasminegpt/backend/src/services/language/languageService.ts); [backend/src/services/router/contextResolver.ts](jasminegpt/backend/src/services/router/contextResolver.ts); [backend/src/services/router/questionRouter.ts](jasminegpt/backend/src/services/router/questionRouter.ts).

1. Validate `conversationId`, nonempty message, and maximum message length.
2. Detect language with `detectLanguage()`.
3. If detected language is Kannada, call `normalizeQueryToEnglish()`.
4. Load conversation, memory, and up to `MAX_CONTEXT_TURNS` recent turns. Default is 8.
5. Resolve follow-up references into `standaloneQuery` using recent turns and memory.
6. Route using deterministic Node keyword/rule logic.
7. Call the Python sidecar through `ragClient.ts`.
8. Filter evidence and construct a prompt or fallback response.
9. Optionally call OpenRouter.
10. Reconcile sources/citations.
11. Translate only the final rendered response to Kannada when target language is Kannada.
12. Persist user and assistant messages, then return JSON.

## 4. Frontend Audit

### Technology and dependencies

**Evidence:** [frontend/package.json](jasminegpt/frontend/package.json).

- React `^19.2.8`
- React DOM `^19.2.8`
- Vite `^8.3.0`
- TypeScript `~6.0.2`
- Tailwind CSS `^3.4.19`
- `lucide-react` `^1.47.0`
- `oxlint` `^1.81.0`

### Frontend features evidenced by source

| Feature | Evidence | Status |
|---|---|---|
| Chat page | `frontend/src/pages/ChatPage/ChatPage` and `App.tsx` | Active runtime |
| Conversation list/history | `useConversations.ts`, `api.ts` | Active runtime |
| Message send/loading/error | `useChat.ts` | Active runtime |
| Evidence/source display | `EvidenceCard`, `SourceCard`, message types/components | Active runtime |
| Language selection | `LanguageSelector`, `languagePreference` request field | Active runtime |
| Speech recognition | `useSpeechRecognition.ts`, `speech.d.ts` | Implemented; exact browser availability depends on browser |
| Farmer profile UI | `useFarmerProfile.ts` and related components | Implemented; memory persistence is backend-backed |
| Government scheme UI | No verified route/API/module found | NOT VERIFIED |
| Authentication UI | No verified implementation found | NOT VERIFIED |

### Frontend API contract

| Component/hook | HTTP | Endpoint | Request | Important response |
|---|---:|---|---|---|
| `api.createConversation()` | POST | `/api/conversations` | `{}` | `conversationId`, `title` |
| `api.listConversations()` | GET | `/api/conversations` | none | conversation array |
| `api.getConversation(id)` | GET | `/api/conversations/:id` | path ID | conversation object |
| `api.getMessages(id)` | GET | `/api/conversations/:id/messages` | path ID | message array |
| `api.sendMessage()` | POST | `/api/chat` | `conversationId`, `message`, `languagePreference` | assistant/user IDs, answer, route, evidence status, sources, resolved query, `llmCalled` |

The frontend `request()` helper parses JSON error bodies and throws a user-visible error message. `useChat()` removes the optimistic message when the request fails.

## 5. Backend Audit

### Framework and entry points

- Express application: [backend/src/app.ts](jasminegpt/backend/src/app.ts), `app`
- Server startup: [backend/src/server.ts](jasminegpt/backend/src/server.ts), `start()`
- Main controller: [backend/src/controllers/chatController.ts](jasminegpt/backend/src/controllers/chatController.ts), `handleChat()`
- RAG client: [backend/src/services/rag/ragClient.ts](jasminegpt/backend/src/services/rag/ragClient.ts)
- LLM service: [backend/src/services/llm/llmService.ts](jasminegpt/backend/src/services/llm/llmService.ts)
- Database: [backend/src/config/database.ts](jasminegpt/backend/src/config/database.ts)
- Environment schema: [backend/src/config/env.ts](jasminegpt/backend/src/config/env.ts)

### Middleware

`app.ts` configures Helmet, CORS from `CORS_ORIGIN`, JSON body parsing with a 1 MB limit, URL-encoded parsing, route mounting, 404 handling, and `errorHandler`.

### Database

MongoDB is connected by `connectDatabase()` in `database.ts`. The URI is composed from `MONGODB_URI` and `MONGODB_DB_NAME`, with `authSource=admin`. The default database name is `jasminesathi_gpt`.

### Models

**Conversation model:** [backend/src/models/Conversation.ts](jasminegpt/backend/src/models/Conversation.ts).

Fields:

- `userId`, indexed, default `default_user`
- `title`
- `memory.species`
- `memory.cultivar`
- `memory.domains[]`
- `memory.last_route`
- `memory.last_document_ids[]`
- timestamps

Indexes include `userId` and descending `updatedAt`.

**Message model:** [backend/src/models/Message.ts](jasminegpt/backend/src/models/Message.ts).

Fields:

- `conversationId`, indexed and referencing conversation
- `role`: `user` or `assistant`
- `content`
- `route`
- `evidenceStatus`
- `sources[]`
- `resolvedQuery`
- `topScore`
- `llmCalled`
- timestamp

Source fields include `documentId`, `title`, `authors`, `year`, `doi`, `page`, `score`, `species`, `category`, `isCrossSpecies`, and `crossSpeciesNote`. A compound index covers conversation and creation time.

The code stores conversation history, resolved query, response content, evidence status, source metadata, and whether an LLM was called. It does not store a full retrieved-context snapshot in the message schema.

## 6. RAG Document Collection and Runtime Files

### 6.1 General RAG files actually loaded

**Evidence:** [rag/general_rag.py](jasminegpt/rag/general_rag.py), `GeneralRAG.__init__()` and `initialize()`.

Default paths:

```text
jasminegpt/rag/data/general_faiss.index
jasminegpt/rag/data/general_chunks.csv
jasminegpt/rag/data/chunk_metadata.csv  # fallback only
jasminegpt/rag/data/metadata.csv        # path assigned but not loaded by initialize()
```

`GENERAL_FAISS_INDEX_PATH` can override the index path. `GENERAL_CHUNKS_CSV_PATH` can override the preferred CSV path. The active code prefers `general_chunks.csv` if it exists and otherwise falls back to `chunk_metadata.csv`.

The two current chunk CSV files are byte-identical and each contains 1,114 data rows. `metadata.csv` contains catalog-level metadata but is not read by the active `GeneralRAG.initialize()` method.

No active runtime reference to `chunks.csv` or `faiss.index` was found. Backup `.bak` files are not loaded.

### 6.2 Post-harvest files actually loaded

**Evidence:** [rag/postharvest_rag.py](jasminegpt/rag/postharvest_rag.py), `_build_corpus_chunks()` and `PostHarvestRAG.initialize()`; [rag/verified_profiles.py](jasminegpt/rag/verified_profiles.py).

The post-harvest runtime does not load `postharvest_extracted_text`, `postharvest_cleaned_text`, `postharvest_chunks`, a post-harvest CSV, or a post-harvest FAISS index. It builds an in-memory DataFrame from five curated profiles.

`PRODUCTION_DOCS` contains:

```text
JAS-SAM-001
JAS-SAM-002
JAS-SAM-004
JAS-SAM-005
JAS-AUR-001
```

`EXCLUDED_DOCS` contains:

```text
JAS-SAM-003: Low-quality scanned PDF removed from production RAG.
```

### 6.3 Collection status

The general corpus is a persisted indexed artifact. The post-harvest corpus is a separate production route, not part of the main general FAISS index. Notebook references to another post-harvest FAISS workflow are legacy/experimental relative to the current checked-in Python service.

## 7. Document Processing and Ingestion

### General builder

**Evidence:** [rag/build_general_corpus.py](jasminegpt/rag/build_general_corpus.py).

- PDF extraction library: `fitz` / PyMuPDF.
- `fitz.open(pdf_path)` opens each PDF.
- `page.get_text()` extracts page text.
- Page markers are inserted as `--- Page N ---` during concatenation.
- The builder removes those page markers from saved chunk text with a regular expression.
- The builder uses `text.split()` for word splitting.
- Saved CSV encoding is UTF-8.
- Embeddings are generated with Sentence Transformers.
- No OCR implementation was found.
- No explicit Unicode normalization was found.
- No general header/footer removal routine was found beyond page-marker removal.
- No explicit duplicate-content removal routine was found.
- No table-specific parser was found.
- No section-aware parser was found.
- Missing PDFs are printed as warnings and skipped by `build_and_save_corpus()`.

The current checked-in CSV contains many source filenames and metadata values beyond the `REAL_PAPERS` catalog visible in the current builder. Therefore, the current builder configuration is not sufficient to prove that every current artifact row was generated by this exact current catalog version.

### Post-harvest processing

`get_profile_text()` in `verified_profiles.py` constructs flat profile text from document ID, title, authors/year, species, cultivar, domains, concepts, and verified facts. `_build_corpus_chunks()` creates one profile chunk, one chunk per fact, and one concepts chunk for each production document. No PDF extraction or OCR occurs in this active route.

## 8. Chunking

### General builder configuration

**Evidence:** [rag/build_general_corpus.py](jasminegpt/rag/build_general_corpus.py), `CHUNK_SIZE`, `CHUNK_OVERLAP`, `split_text_words()`.

```text
Chunk size: 2,000 words
Overlap: 400 words
Unit: whitespace-delimited words
Step: size - overlap = 1,600 words
Minimum retained chunk: more than 30 words
```

The code does not use token-based splitting, recursive separators, heading-aware splitting, or a maximum-token constraint. Page markers may cross chunk boundaries because the full document text is concatenated before word splitting. The runtime loads existing chunks and does not re-chunk them.

### Post-harvest chunking

Post-harvest chunks are semantic profile/fact/concept records rather than fixed word windows. The active code defines no word-size or overlap for them.

### Builder versus final artifact

The values `2,000` and `400` are verified builder configuration. The final artifact contains 1,114 rows, but the repository does not independently record the exact historical builder version or acquisition run that produced every current row. Report the chunk configuration as builder-defined, with this qualification.

## 9. Verified Knowledge-Base Statistics

All counts below were recalculated from the current files with read-only Python and, for FAISS, the existing project virtual environment.

### General corpus

| Metric | Calculation | Result | Status |
|---|---|---:|---|
| Chunk rows | `len(csv.DictReader(chunk_metadata.csv))` | 1,114 | Verified production artifact |
| FAISS vectors | `faiss.read_index(...).ntotal` | 1,114 | Verified production artifact |
| Vector dimension | `index.d` | 384 | Verified production artifact |
| Index class | `type(index).__name__` | `IndexFlatIP` | Verified production artifact |
| CSV/index agreement | `len(rows) == index.ntotal` | `True` | Verified |
| Unique filename references | `len(set(row['filename']))` | 170 | Verified |
| Sambac chunks | `species == 'Jasminum sambac'` | 746 | Verified |
| Auriculatum chunks | `species == 'Jasminum auriculatum'` | 170 | Verified |
| Unique sambac filenames | unique filenames after species filter | 127 | Verified CSV-derived |
| Unique auriculatum filenames | unique filenames after species filter | 27 | Verified CSV-derived |
| Target-status rows | `target_status == 'TARGET_SPECIES'` | 916 | Verified |
| Comparative rows | `target_status == 'MULTI_SPECIES_COMPARATIVE'` | 45 | Verified |
| Excluded-status rows | `target_status == 'EXCLUDED_FROM_TARGET_SPECIES'` | 153 | Verified |
| Target-status unique filenames | unique filenames after status filter | 149 | Verified |
| Comparative unique filenames | unique filenames after status filter | 6 | Verified |
| Excluded unique filenames | unique filenames after status filter | 15 | Verified |
| Metadata catalog rows | `len(metadata.csv)` | 178 | Verified |
| Metadata unique filenames | `len(set(metadata.filename))` | 170 | Verified |

The status-row totals sum to 1,114: `916 + 45 + 153 = 1,114`. The unique-status filename totals overlap in the sense that metadata rows can contain multiple records for a filename: the artifact has 149 target-status filenames, 6 comparative filenames, and 15 excluded-status filenames.

The general chunk CSV has 11 observed category values. Categories are data values, not all necessarily router labels. Active routing terms include pest, nutrition, irrigation, pruning, disease, breeding, variety, cultivation defaults, and post-harvest routing terms. The exact current category counts should be regenerated from the CSV if a paper table requires them; the audit did not convert category labels into additional semantic claims.

### Chunk distribution by source filename

The complete frequency distribution is:

| Chunks per filename | Number of filenames |
|---:|---:|
| 1 | 8 |
| 2 | 41 |
| 3 | 50 |
| 4 | 15 |
| 5 | 5 |
| 6 | 5 |
| 8 | 5 |
| 10 | 2 |
| 11 | 1 |
| 12 | 4 |
| 13 | 3 |
| 14 | 5 |
| 15 | 1 |
| 16 | 6 |
| 17 | 2 |
| 18 | 2 |
| 19 | 5 |
| 20 | 2 |
| 21 | 2 |
| 23 | 2 |
| 25 | 2 |
| 30 | 1 |
| 47 | 1 |

Check: multiplying each chunk-count value by its number of filenames gives 1,114 total rows.

### Data-quality checks

The current audit pass verified that chunk IDs are unique, chunk text is nonempty, and each chunk has a filename. Repeated filenames are expected because one source document contributes multiple chunks; they are not duplicate chunk IDs. `cross_species_note` is frequently blank by design for direct/ordinary records. Metadata missingness and category distributions were measured from the files during the audit and should be regenerated if the files change.

### Post-harvest corpus

| Metric | Calculation | Result | Status |
|---|---|---:|---|
| Production documents | `len(PRODUCTION_DOCS)` | 5 | Active production route |
| Generated chunks | `len(_build_corpus_chunks())` | 44 | Active production route |
| Profile chunks | one per production document | 5 | Active production route |
| Fact chunks | sum of `len(verified_facts)` | 34 | Active production route |
| Concepts chunks | one per production document | 5 | Active production route |
| Explicitly excluded profiles | `len(EXCLUDED_DOCS)` | 1 | Active source-of-truth declaration |

Per-document post-harvest chunks are 10, 10, 9, 8, and 7 for `JAS-SAM-001`, `JAS-SAM-002`, `JAS-SAM-004`, `JAS-SAM-005`, and `JAS-AUR-001`, respectively.

## 10. Metadata Schema

### General chunk CSV

The current `general_chunks.csv` and `chunk_metadata.csv` fields are:

```text
chunk_id
text
filename
species
category
source
target_status
real_species
cross_species_note
```

These are stored as CSV. The builder in `build_general_corpus.py` historically creates a richer schema containing title, author, keyword, year, DOI, URL, page, and text, but the current loaded CSV does not contain all of those columns. `GeneralRAG.retrieve()` therefore derives title/year in some cases and returns `None` for unavailable fields such as author/DOI/URL/page when absent.

### Metadata catalog

[metadata.csv](jasminegpt/rag/data/metadata.csv) contains:

```text
filename
species
category
source
path
target_status
real_species
cross_species_note
```

It contains 178 rows and 170 unique filenames. It is assigned as a path in `GeneralRAG` but is not loaded in the active initialization method.

### Post-harvest document metadata

`verified_profiles.py` stores manually curated fields including species, cultivar, year, title, authors, DOI, domains, concepts, aliases, verified facts, and limitations. The response document schema adds rank and route reasons.

Post-harvest generated chunk fields are `chunk_id`, `document_id`, `page`, `text`, and `chunk_type`. Retrieval adds semantic score, lexical score, and hybrid score before returning chunk records.

## 11. Species Filtering

### General RAG order

The current `GeneralRAG.retrieve()` flow is:

```text
query embedding
-> FAISS candidate search with candidate_k
-> CSV row-position mapping
-> target_status/species filtering
-> category filtering when detected
-> optional cross-species path
-> keyword boost for bud worm/bud borer
-> score sort
-> drop duplicate filename
-> final top_k
```

The default species at the FastAPI endpoint is `Jasminum sambac` when the request and memory do not specify a species. The backend also defaults to `Jasminum sambac` in `handleChat()`.

For a specified species, direct candidates must satisfy:

```python
(target_status == 'TARGET_SPECIES') and species.str.contains(species)
```

The application calls general retrieval with `allowCrossSpecies: false`. The Node controller additionally canonicalizes recognized species and demotes mismatches to a cross-species bucket before topic filtering.

The current CSV includes other species and multi-species records. They are present in the index, but normal direct target-species retrieval is intended to exclude them. If direct evidence is absent and cross-species use is disallowed, the result can become empty/insufficient. The code does not implement a probabilistic species classifier.

### Post-harvest species handling

The post-harvest router detects aliases and scores the five manually defined profiles. It does not use the general CSV species field or general FAISS index.

## 12. Topic and Query Routing

### Node runtime router

**Evidence:** [backend/src/services/router/questionRouter.ts](jasminegpt/backend/src/services/router/questionRouter.ts), `routeQuestion()`.

Routes are:

- `MEMORY_UPDATE`
- `GENERAL_RAG`
- `POSTHARVEST`

General keyword groups include pest, nutrition, irrigation, pruning, disease, breeding, and variety. Post-harvest groups include packaging, storage, transportation, harvesting, shelf life, cold storage, export, gel ice, boric acid, chitosan, and mycelium. Profile statements route to memory update unless the same message also contains question/management signals.

Routing is deterministic keyword/regular-expression logic. It is not an LLM classifier, embedding classifier, or trained intent model.

### Python router

**Evidence:** [rag/router.py](jasminegpt/rag/router.py), `route_top_level()` and `route_postharvest_query()`.

The Python router mirrors the top-level domains and adds deterministic post-harvest species/domain/concept/temperature routing. `TOP_K_DOCS = 4` controls selected post-harvest documents.

## 13. Evidence-Status System

General and post-harvest evidence statuses are metadata/rule gates, not calibrated confidence scores.

### General statuses

The general CSV stores `target_status` values:

- `TARGET_SPECIES`
- `MULTI_SPECIES_COMPARATIVE`
- `EXCLUDED_FROM_TARGET_SPECIES`

The current general retriever uses `TARGET_SPECIES` for direct target-species filtering. Cross-species records can be returned only when the relevant path explicitly permits them; the current backend call sets `allowCrossSpecies: false`. The Node controller also checks species mismatch and labels cross evidence.

### Post-harvest statuses

`route_postharvest_query()` returns:

- `DIRECT_EVIDENCE`
- `MULTIPLE_STUDIES`
- `INSUFFICIENT_EVIDENCE`

`PostHarvestRAG._validate_evidence()` returns `supported`, an evidence status, and a message. The LLM is not called when evidence is unsupported.

### No-evidence behavior

- General route with no accepted direct/cross evidence: formatted insufficient-evidence response; no LLM call.
- Post-harvest insufficient evidence: exact insufficient-evidence response; no LLM call.
- Supported evidence with no OpenRouter key: deterministic formatted fallback from retrieved facts/chunks.
- Supported evidence with LLM failure: deterministic formatted fallback.
- No fallback model is configured.

## 14. Embedding Models

### General

**Evidence:** [rag/general_rag.py](jasminegpt/rag/general_rag.py), `EMBED_MODEL_NAME`, `GeneralRAG.initialize()`, `retrieve()`.

- Model: `BAAI/bge-small-en-v1.5`
- Library: `sentence_transformers.SentenceTransformer`
- Normalization: `normalize_embeddings=True` for documents during builder creation and queries during retrieval
- Verified dimension: 384 from the loaded FAISS index
- Query method: `self.embedder.encode([query], normalize_embeddings=True)`
- Builder batch size: 32
- Device: not explicitly configured; **NOT VERIFIED** whether CPU/GPU was used during artifact creation
- Pooling internals/model version: **NOT VERIFIED** from repository

### Post-harvest

- Model: `sentence-transformers/all-MiniLM-L6-v2`
- Normalization: `normalize_embeddings=True`
- Query and document vectors are converted to NumPy `float32`
- Explicit post-harvest dimension: **NOT VERIFIED** in source or persisted artifact
- Device/model package version: **NOT VERIFIED**

## 15. FAISS Index and Retrieval

### Index construction

**Evidence:** [rag/build_general_corpus.py](jasminegpt/rag/build_general_corpus.py).

```python
emb = np.array(embeddings).astype('float32')
index = faiss.IndexFlatIP(emb.shape[1])
index.add(emb)
faiss.write_index(index, faiss_path)
```

### Index loading

**Evidence:** [rag/general_rag.py](jasminegpt/rag/general_rag.py), `faiss.read_index(self._faiss_path)`.

The loaded artifact is `IndexFlatIP`, which uses inner product. Because document and query embeddings are normalized, the active calculation is equivalent to cosine similarity for these vectors. The code does not call this a calibrated confidence score.

### Search parameters

```python
candidate_k = min(len(self.chunks_df), max(top_k * 8, 40))
scores, ids = self.index.search(q_emb, candidate_k)
```

The public general default is `top_k = 5`; the Node controller explicitly calls `retrieveGeneral(..., 5, ...)`. Therefore candidate retrieval normally requests 40 vectors and final output is up to 5 after filtering/deduplication.

### Alignment

The runtime maps returned FAISS IDs to CSV row positions using `self.chunks_df.iloc[valid_indices]`. The current artifact cardinalities match: 1,114 CSV rows and 1,114 vectors. The repository does not store a separate vector-to-document key file.

## 16. Retrieval Pipeline and Hit@5

The raw candidate pool is not necessarily raw Top-5. The general service requests `max(top_k * 8, 40)`, then applies target species and category logic, keyword boost, sorting, duplicate filename removal, and `head(top_k)`. The Node backend then applies species canonicalization and topic filtering again before evidence status and prompt construction.

The post-harvest route does not use FAISS. It ranks all in-memory chunks restricted to selected documents and returns the top 8 internally, then truncates the response packet to 5 chunks.

No implementation of Hit@5, recall, precision, MRR, groundedness scoring, or relevance evaluation was verified. Therefore:

> **Hit@5: NOT IMPLEMENTED — must be defined manually for paper evaluation.**

A paper must specify whether its future Hit@5 denominator is raw candidate pool, post-filter candidates, final context, or another definition; the repository does not choose one.

## 17. Post-harvest Hybrid Retrieval

**Evidence:** [rag/postharvest_rag.py](jasminegpt/rag/postharvest_rag.py).

Constants:

```text
SEMANTIC_WEIGHT = 0.65
LEXICAL_WEIGHT = 0.35
TOP_K_CHUNKS = 8
EMBED_MODEL_NAME = sentence-transformers/all-MiniLM-L6-v2
```

Semantic score:

```python
q_emb = embedder.encode([query], normalize_embeddings=True)[0]
sem_scores = X_sem @ q_emb
```

Lexical score:

```python
TfidfVectorizer(
    lowercase=True,
    ngram_range=(1, 2),
    min_df=1,
    max_df=0.98,
    sublinear_tf=True,
)
q_lex = vectorizer.transform([query])
lex_scores = (X_lex @ q_lex.T).toarray().ravel()
if lex_scores.max() > 0:
    lex_scores = lex_scores / lex_scores.max()
```

Hybrid formula:

$$
S_{hybrid} = 0.65 S_{semantic} + 0.35 S_{lexical}
$$

The DataFrame is filtered to `allowed_docs`, sorted descending by `hybrid_score`, and truncated to 8. The response returns `packet["chunks"][:5]`. No BM25 implementation, string-only fallback, or FAISS index is used in this route.

## 18. LLM Generation and Prompts

### Provider/configuration

**Evidence:** [backend/src/config/env.ts](jasminegpt/backend/src/config/env.ts), [backend/src/services/llm/llmService.ts](jasminegpt/backend/src/services/llm/llmService.ts).

- Provider/API: OpenRouter OpenAI-compatible `/chat/completions`
- Default model: `openai/gpt-4o-mini`
- Override variable: `OPENROUTER_MODEL`
- Base URL variable: `OPENROUTER_BASE_URL`
- Temperature: `0.2`
- Max tokens: `800`
- Timeout: 30 seconds
- Top-p: not used
- Retry logic: no model retry; errors become fallback responses
- API key variable: `OPENROUTER_API_KEY` (value not inspected/reported)

The system prompt requires retrieved-evidence-only answers, species/cultivar separation, numerical safety, paper-title citations, concise farmer-friendly output, and explicit insufficient-evidence behavior. `buildGeneralPrompt()` and `buildPostHarvestPrompt()` format source metadata, evidence text, facts, limitations, active species, user question, and formatting instructions.

The prompt instructions address grounding, hallucination prevention, citations, unsupported claims, symptom evidence gaps, topic relevance, and cross-cultivar/species separation. These are prompt instructions; they do not prove model-level factual guarantees.

### Fallback

If no key is configured, or `callLLM()` fails, the controller uses `formatGeneralFallback()` or `formatPostHarvestFallback()`. No alternate model is called.

## 19. Kannada and Multilingual Support

**Evidence:** [backend/src/services/language/languageService.ts](jasminegpt/backend/src/services/language/languageService.ts), `detectLanguage()`, `normalizeQueryToEnglish()`, `translateResponseToTarget()`.

Supported target languages in the typed API are English and Kannada. Detection uses:

- Kannada Unicode range `U+0C80-U+0CFF`
- deterministic transliterated-Kannada regular expressions
- explicit user preference override

For a Kannada query, the backend normalizes it to English before routing/retrieval. Retrieved documents are not translated. The final rendered answer is translated to Kannada after evidence/citation reconciliation when the target language is Kannada. The service masks protected scientific entities/placeholders during translation and contains an offline deterministic fallback path. Exact external translation model/provider behavior is not fully established without a live configured key; the code uses the same OpenRouter configuration for its online translation requests.

## 20. Conversation Memory

**Evidence:** [backend/src/services/conversation/conversationService.ts](jasminegpt/backend/src/services/conversation/conversationService.ts), `getMemory()`, `updateMemory()`, `mergeMemoryFromQuestion()`, `getRecentTurns()`; [backend/src/services/router/contextResolver.ts](jasminegpt/backend/src/services/router/contextResolver.ts).

Memory is stored in MongoDB conversation documents. Stored fields include species, cultivar, domains, last route, and last document IDs. Recent turns default to 8 messages/turn records through `MAX_CONTEXT_TURNS`.

Follow-up resolution uses recent messages, memory, deterministic reference/context patterns, and query rewriting. Memory influences routing, target species/cultivar selection, and post-harvest follow-up routing. The memory object is not directly inserted as a standalone LLM context block; resolved query and retrieved context are passed into prompts.

No summarization model or long-term user profile database beyond conversation memory was verified.

## 21. Citation Reconciliation

**Evidence:** [backend/src/conversation/citationReconciler.ts](jasminegpt/backend/src/services/conversation/citationReconciler.ts), called by `handleChat()`.

The controller passes generated/fallback answer text and the source list to `reconcileSourcesAndEvidence()`. The reconciler is intended to enforce consistency between answer citations and available source records. Source metadata comes from retrieved RAG records and is persisted in the message.

The repository does not establish an external citation resolver or bibliographic lookup. Citation behavior is application-level text/source reconciliation. Exact mismatch rules are implemented in the reconciler file; nonexistent external sources cannot be validated against the internet by this code. Page-level values are only available if supplied by the retrieved record; current general CSV rows do not consistently contain page metadata.

## 22. No-Evidence and Error Behavior

| Condition | Actual behavior |
|---|---|
| Empty/invalid chat request | Controller throws validation error; middleware formats error response |
| Missing RAG sidecar | Axios client maps connection errors to RAG unavailable error |
| Missing general index | Python `initialize()` raises `FileNotFoundError`; sidecar startup is not ready |
| Missing general CSV | Python `initialize()` raises `FileNotFoundError` |
| CSV/index row mismatch | Warning is logged; initialization continues |
| No general accepted evidence | Insufficient-evidence response; LLM not called |
| Post-harvest insufficient evidence | Insufficient-evidence response; LLM not called |
| No OpenRouter key | Evidence fallback is returned; synthesis disabled |
| OpenRouter failure | Formatted evidence fallback is returned |
| Database connection failure | Server startup fails with logged error |
| Frontend request failure | Error is caught and optimistic message removed |
| Kannada translation failure | Language service fallback/error path applies; exact live outcome depends on implementation/configuration |
| Missing PDF during builder run | Warning printed and PDF skipped |
| Malformed current CSV schema | Existing tests can fail; no general runtime schema migration is present |

## 23. Government Scheme Module

**Result:** `NOT VERIFIED AS RUNTIME IMPLEMENTATION`.

A complete repository search did not find a government-scheme data source, schema, backend route, retrieval collection, recommendation algorithm, eligibility filter, subsidy field, application workflow, or frontend API flow for schemes. The active query router has no government-scheme route. Government schemes must not be described as an implemented JasmineGPT capability based on the current repository.

## 24. Security and Configuration

Environment variable names verified in [backend/src/config/env.ts](jasminegpt/backend/src/config/env.ts):

```text
NODE_ENV
PORT
MONGODB_URI
MONGODB_DB_NAME
RAG_SIDECAR_URL
OPENROUTER_API_KEY
OPENROUTER_MODEL
OPENROUTER_BASE_URL
CORS_ORIGIN
LOG_LEVEL
MAX_MESSAGE_LENGTH
MAX_CONTEXT_TURNS
```

Frontend variable:

```text
VITE_API_BASE_URL
```

Python-side general overrides:

```text
GENERAL_FAISS_INDEX_PATH
GENERAL_CHUNKS_CSV_PATH
BACKEND_ORIGIN
RAG_PORT
```

Security controls found: Helmet, CORS allowlist, request size limit, Zod environment validation, and no hard-coded OpenRouter key. No authentication, authorization, rate limiting, or user identity implementation was verified. The default backend user ID is `default_user`.

## 25. Software and Environment

### Version evidence

| Component | Version evidence |
|---|---|
| React | `^19.2.8` in frontend package.json |
| React DOM | `^19.2.8` |
| Vite | `^8.3.0` |
| TypeScript frontend | `~6.0.2` |
| TypeScript backend | `^5.4.5` |
| Express | `^4.19.2` |
| Mongoose | `^8.3.3` |
| Axios | `^1.6.8` backend |
| FastAPI | `>=0.110.0` in requirements.txt |
| FAISS CPU | `>=1.8.0` in requirements.txt; existing environment reported `faiss_cpu-1.15.0` metadata during audit |
| Sentence Transformers | `>=2.7.0` in requirements.txt; exact runtime package pin not declared |
| pandas | `>=2.0.0` |
| NumPy | `>=1.26.0` |
| scikit-learn | `>=1.4.0` |
| LangChain | Not found in active dependency manifests |
| ChromaDB | Not found in active dependency manifests |
| Gemini SDK | Not found in active dependency manifests |
| Node/Python exact interpreter | NOT VERIFIED from project files |

Requirements are minimum ranges rather than a fully pinned reproducibility lock. Hardware, CUDA/device, random seeds, and exact model revisions are not recorded.

## 26. Deployment Architecture

The repository documents local three-process operation:

- Vite frontend, normally port 5173
- Express backend, default port 4000
- FastAPI RAG sidecar, default port 8000
- MongoDB, default local URI/database configuration

The Node backend calls the Python sidecar over HTTP using `RAG_SIDECAR_URL`. No Dockerfile, compose file, cloud hosting configuration, or production deployment manifest was found. Production hosting and database hosting are **NOT VERIFIED**.

## 27. Evaluation Code

The repository contains unit/regression tests for routing, conversation behavior, citation reconciliation, cultivar evidence, language service, symptom responses, and topic filtering. Python tests cover routing and general RAG/startup behavior.

A repository-wide search did not verify:

- stored Q1-Q5 evaluation questions
- Hit@5 implementation
- automated relevance labels
- groundedness/hallucination scoring
- a baseline implementation
- a web-search baseline
- reported model outputs or numerical evaluation results
- a scoring rubric

Therefore:

> **Q2-Q5 NOT FOUND IN REPOSITORY**

More broadly, Q1-Q5 as a complete reproducible evaluation protocol is **NOT VERIFIED**.

One important test gap was observed: the general RAG test path can fail during collection with `KeyError: 'author'` because the current chunk CSV schema does not contain the `author` column expected by that test's output formatting. This is a repository inconsistency, not a corrected implementation.

## 28. Reproducibility Assessment

### Verified

- General embedding model name
- General FAISS class, metric behavior, dimension, vector count
- Current chunk CSV row count and fields
- Current filename/species/status counts
- General builder chunk size/overlap
- General candidate and final Top-K logic
- Post-harvest production document IDs and profile fields
- Post-harvest chunk construction and hybrid formula
- OpenRouter model default and generation parameters
- Backend/frontend route contracts
- Mongo schemas
- Prompt variable locations

### Missing or not recorded

- Exact historical source-download list/run and acquisition date
- Exact model revision hashes
- Exact Python/Node runtime versions
- Hardware/device used for embedding/index creation
- General source-PDF files corresponding to every CSV filename
- Exact historical preprocessing version for current CSV
- Random seeds
- Complete evaluation questions/results/rubric
- Hit@5 definition
- Production deployment topology
- Government-scheme dataset/algorithm
- Post-harvest embedding dimension in source/artifact

## 29. Figures Supported by the Repository

| Figure | Supported content | Verification |
|---|---|---|
| Figure 1 | Frontend -> Express -> FastAPI -> FAISS/in-memory post-harvest -> OpenRouter -> MongoDB architecture | Fully supported by active source |
| Figure 2 | General PDF extraction, word chunking, Sentence Transformer embedding, CSV/FAISS persistence | Builder-supported; historical artifact provenance partially qualified |
| Figure 3 | Query embedding, 40-candidate minimum search, CSV row mapping, filtering, final Top-K | Fully supported |
| Figure 4 | Evidence gate, prompt construction, LLM/fallback, citation reconciliation, final translation | Fully supported |
| Figure 5 | Deterministic Node/Python routing and post-harvest document scoring | Fully supported |
| Figure 6 | Evaluation workflow | Only tests are supported; Q1-Q5/results are NOT VERIFIED |

## 30. Tables Supported by the Repository

Recommended paper tables:

1. Knowledge Base Statistics: 1,114 rows, 170 filenames, 1,114 vectors, 384 dimensions, species/status counts.
2. Software and Model Configuration: React/Vite, Express, FastAPI, Sentence Transformers, FAISS, OpenRouter, MongoDB.
3. Metadata Schema: exact CSV, catalog, post-harvest profile, and message source fields.
4. Retrieval Configuration: normalization, `IndexFlatIP`, candidate pool, Top-K, species/topic filters.
5. Post-harvest Configuration: five profiles, 44 chunks, MiniLM, TF-IDF, 0.65/0.35 formula, Top-K.
6. Query Routing: `MEMORY_UPDATE`, `GENERAL_RAG`, `POSTHARVEST` rules.
7. Evaluation Tests: test-file inventory only; numerical evaluation results are not verified.

Do not create an evaluation-results or baseline-comparison table until data is supplied externally or implemented and run.

## 31. Claims We Can Safely Make

- The active application has a React/Vite frontend, Express/TypeScript backend, and FastAPI/Python RAG sidecar.
- General retrieval loads `general_faiss.index` and prefers `general_chunks.csv`, falling back to `chunk_metadata.csv`.
- The current general CSV contains 1,114 non-header rows and 170 unique filename references.
- The current FAISS artifact contains 1,114 384-dimensional vectors and is an `IndexFlatIP` index.
- General query/document embeddings use normalized `BAAI/bge-small-en-v1.5` embeddings in the active code path.
- The current CSV has 746 sambac chunks and 170 auriculatum chunks by its `species` field.
- The current CSV has 916 target-status, 45 comparative-status, and 153 excluded-status rows.
- The post-harvest runtime uses five curated profiles and generates 44 in-memory chunks.
- Post-harvest retrieval uses `all-MiniLM-L6-v2`, TF-IDF, and the implemented 0.65/0.35 hybrid formula.
- The default LLM configuration is `openai/gpt-4o-mini` through OpenRouter.
- Conversations and messages are stored in MongoDB.
- English/Kannada handling is deterministic language detection plus query normalization and final-answer translation.
- LLM synthesis is evidence-gated and has formatted fallback behavior.

## 32. Claims We Must Not Make

- The system guarantees factual correctness or eliminates hallucination.
- The model was fine-tuned.
- All 178 metadata rows are 178 unique PDFs in the final corpus.
- `metadata.csv` is actively loaded during general runtime.
- `faiss.index` or `chunks.csv` is used.
- The named source folders are used.
- Post-harvest chunks are part of the general FAISS index.
- The system implements government-scheme recommendations.
- Hit@5 or any reported retrieval metric exists in the repository.
- Q1-Q5 results exist in the repository.
- The system uses ChromaDB, LangChain, or Gemini in the current runtime.
- Every current CSV row was necessarily generated by the current `REAL_PAPERS` catalog.
- The post-harvest embedding dimension is verified.
- The source collection is exclusively official/government/academic without external source audit.

## 33. Claims Requiring External References

Code cannot establish:

- agronomic correctness of recommendations
- scientific quality or authority of each source
- efficacy of treatments
- generalizability across cultivars/geographies
- farmer outcomes
- government eligibility or subsidy facts
- claims about language quality
- claims of reduced hallucination or improved trustworthiness
- comparison to prior research or competing systems

These require source papers, government documents, user studies, or controlled evaluation results.

## 34. Paper-Specific Gap Matrix

| Item | Found? | Answer |
|---|---|---|
| PDF/text extraction library | Yes | PyMuPDF/`fitz`, `page.get_text()` in `build_general_corpus.py` |
| Cleaning rules | Partial | Page-marker removal and `strip()`; broader cleaning NOT VERIFIED |
| Exact chunk size | Yes | 2,000 words in builder |
| Chunk overlap | Yes | 400 words in builder |
| Chunking method | Yes | whitespace word windows, minimum >30 words |
| FAISS index type | Yes | `IndexFlatIP` |
| Similarity metric | Yes | inner product; normalized vectors make it cosine-equivalent |
| Embedding normalization | Yes | `normalize_embeddings=True` |
| Query routing | Yes | deterministic Node/Python keyword/rule logic |
| Comparative handling | Yes | status fields plus species/cross-species filtering |
| Excluded handling | Yes | excluded rows indexed but filtered from direct target evidence |
| No-evidence behavior | Yes | no LLM; insufficient-evidence response/fallback |
| Citation mismatch behavior | Yes, implementation present | `reconcileSourcesAndEvidence()`; external source validation NOT VERIFIED |
| Kannada translation | Yes | Unicode/transliteration detection, English normalization, final output translation |
| Database persistence | Yes | MongoDB conversations/messages |
| Government scheme implementation | No | NOT VERIFIED AS RUNTIME IMPLEMENTATION |
| Post-harvest formula | Yes | `0.65*semantic + 0.35*lexical` |
| Exact Q1-Q5 | No | NOT FOUND IN REPOSITORY |
| Evaluation scoring | No | NOT VERIFIED |
| Baseline | No | NOT VERIFIED |
| Model parameters | Partial | LLM temperature 0.2/max 800; embedding revisions/device NOT VERIFIED |
| Software versions | Partial | manifests/requirements give ranges; exact environment not fully pinned |
| Source document types | Partial | current CSV filenames and PDF builder indicate papers/PDFs; complete provenance NOT VERIFIED |
| Corpus acquisition process | Partial | builder expects local Downloads PDFs; complete acquisition history NOT VERIFIED |
| Metadata generation | Partial | builder programmatically assigns fields; current CSV schema reflects later artifact |
| Source URLs | Partial | present in builder catalog, absent from current chunk CSV schema |
| Species classification | Yes | metadata/status plus deterministic aliases/string checks |

## 35. Source Code Statistics

The source inventory performed for this audit counted implementation files while excluding dependency trees and generated build output:

| Statistic | Count/status |
|---|---:|
| Python files | 11 |
| TypeScript files | 39 |
| TSX files | 17 |
| Notebooks | 2 checked-in notebooks |
| General data CSVs | 3 primary CSVs plus backups |
| Backend model files | 2 |
| Main backend route groups | 2: conversations and chat |
| Python RAG services | General and post-harvest |
| Docker files | None found |
| `pyproject.toml` | Not found |

Generated `dist` files and virtual-environment dependencies are not treated as source implementation in these counts.

## 36. Unused, Legacy, and Conflicting Implementation

1. **Root README technology table:** says ChromaDB, LangChain, and Gemini; active manifests/source use FAISS, Sentence Transformers, OpenRouter, and MongoDB. Treat the table as stale documentation.
2. **`metadata.csv`:** configured as a general metadata path but not loaded by `GeneralRAG.initialize()`.
3. **`.bak` CSV files:** present but not loaded.
4. **Notebook post-harvest FAISS references:** legacy/experimental relative to current `PostHarvestRAG`, which builds in-memory profiles.
5. **Current builder catalog versus current CSV:** current artifact contains 170 filenames, while the current `REAL_PAPERS` list is smaller and does not by itself explain every artifact filename. Historical generation provenance is NOT VERIFIED.
6. **General RAG tests:** one test path expects columns such as `author` that are absent from the current chunk CSV; this is a test/artifact schema inconsistency.
7. **Configured document metadata path:** no runtime use found.
8. **Government schemes:** no active implementation found despite the broader decision-support framing.

## 37. Final Runtime Trace: Normal General Jasmine Question

Example query: `What pruning practices are recommended for Jasminum sambac plants?`

1. Frontend `ChatPage`/`useChat()` sends `POST /api/chat` through `frontend/src/services/api.ts`.
2. Express mounts `/api/chat` to `handleChat()` in `backend/src/controllers/chatController.ts`.
3. `handleChat()` validates conversation ID/message length.
4. `detectLanguage()` identifies English; no Kannada normalization is needed.
5. `getConversation()`, `getMemory()`, and `getRecentTurns()` load MongoDB state.
6. `resolveFollowup()` creates a standalone query, normally unchanged for this self-contained question.
7. `routeQuestion()` identifies pruning as `GENERAL_RAG`.
8. `retrieveGeneral()` sends the query and `top_k: 5` to the FastAPI `/rag/general` endpoint.
9. FastAPI `general_retrieve()` defaults species to `Jasminum sambac` if needed and calls `GeneralRAG.retrieve()`.
10. `GeneralRAG` encodes the query with normalized `BAAI/bge-small-en-v1.5` embeddings.
11. FAISS searches `candidate_k = max(5*8, 40)`, capped by corpus size.
12. IDs map directly to CSV row positions through `DataFrame.iloc`.
13. Python applies target-species/status and category logic, sorts, removes duplicate filenames, and returns up to 5 chunks.
14. Node canonicalizes species and separates direct/cross species evidence.
15. `filterChunksByTopic()` retains pruning-relevant chunks.
16. Evidence status becomes `DIRECT_EVIDENCE`, `SOURCE_REVIEW_REQUIRED`, or `INSUFFICIENT_EVIDENCE` according to the resulting evidence.
17. If insufficient, the backend returns the evidence-gap sentence without calling the LLM.
18. If supported and `OPENROUTER_API_KEY` is configured, `buildGeneralPrompt()` constructs context from selected chunks and `callLLM()` sends the system/user messages to OpenRouter using `openai/gpt-4o-mini` by default.
19. If synthesis is disabled/fails, `formatGeneralFallback()` returns structured evidence.
20. `reconcileSourcesAndEvidence()` reconciles answer/source consistency.
21. If target language is Kannada, `translateResponseToTarget()` translates the final rendered response.
22. User and assistant messages, route, evidence status, sources, resolved query, and `llmCalled` are persisted to MongoDB.
23. JSON response returns IDs, answer, route, evidence status, sources, resolved query, language information, and optional score.
24. `useChat()` replaces the optimistic message with the persisted user/assistant response and renders the assistant/source UI.

## 38. Draft-Statistic Verification

| Draft value | Actual repository result | Evidence |
|---|---|---|
| 1,114 general chunks | Confirmed | Current chunk CSV row count |
| 170 unique document references | Confirmed | Unique `filename` values |
| 1,114 FAISS vectors | Confirmed | `index.ntotal` |
| 384 dimensions | Confirmed | `index.d` |
| 127 sambac documents | Confirmed as unique filename count by `species` | Current chunk CSV |
| 27 auriculatum documents | Confirmed as unique filename count by `species` | Current chunk CSV |
| 746 sambac chunks | Confirmed | Current chunk CSV |
| 170 auriculatum chunks | Confirmed | Current chunk CSV |
| 149 target-species documents | Confirmed unique filenames by `target_status` | Current chunk CSV |
| 6 comparative documents | Confirmed unique filenames by status | Current chunk CSV |
| 15 excluded documents | Confirmed unique filenames by status | Current chunk CSV |
| 916 target chunks | Confirmed | Current chunk CSV |
| 45 comparative chunks | Confirmed | Current chunk CSV |
| 153 excluded chunks | Confirmed | Current chunk CSV |
| 178 metadata rows | Confirmed | `metadata.csv` |
| 170 metadata unique filenames | Confirmed | `metadata.csv` |
| 5 post-harvest documents | Confirmed | `PRODUCTION_DOCS` |
| 44 post-harvest chunks | Confirmed | `_build_corpus_chunks()` |
| 1 excluded post-harvest document | Confirmed | `EXCLUDED_DOCS` |
| `BAAI/bge-small-en-v1.5` | Confirmed general model | `general_rag.py` and builder |
| 384 general dimensions | Confirmed artifact | FAISS index |
| `all-MiniLM-L6-v2` | Confirmed post-harvest model name | `postharvest_rag.py` |
| Semantic 0.65 / lexical 0.35 | Confirmed | `postharvest_rag.py` constants/formula |
| GPT-4o-mini/OpenRouter | Confirmed default configuration | `env.ts` and `llmService.ts` |

## 39. Final Summary for IEEE Paper

### A. Verified technical facts

The safest implementation description is: React/Vite frontend, Express/TypeScript backend, FastAPI/Python RAG sidecar, MongoDB persistence, persisted general FAISS `IndexFlatIP` retrieval with 1,114 384-dimensional vectors, normalized `BAAI/bge-small-en-v1.5` embeddings, deterministic species/topic/evidence filters, a separate five-document/44-chunk post-harvest hybrid retriever using MiniLM and TF-IDF, and optional OpenRouter `openai/gpt-4o-mini` synthesis with evidence fallbacks.

### B. Implementation details still missing

Exact historical corpus acquisition, PDF-to-current-CSV provenance, model revision hashes, exact runtime versions, hardware/device, post-harvest embedding dimension, source authority verification, production deployment, and complete citation/retrieval evaluation protocol.

### C. Evaluation data still missing

Q1-Q5 questions/results, relevance labels, Hit@5 definition, precision/recall/MRR, groundedness/hallucination rubric, baseline system, repeated-run protocol, and statistical analysis.

### D. External references still required

All agronomic/scientific claims, treatment efficacy, government information, source authority, language-quality claims, and comparative claims against other systems.

### E. Potential overclaims to remove

Remove or qualify claims that the system guarantees no hallucinations, guarantees factual correctness, uses ChromaDB/LangChain/Gemini, includes all collected documents, implements government schemes, or has measured retrieval performance.

### F. Recommended IEEE figures

Use the six figures in Section 29, omitting or labeling the evaluation figure as test infrastructure only until Q1-Q5 evaluation data exists.

### G. Recommended IEEE tables

Use knowledge-base statistics, software/model configuration, metadata schema, general retrieval configuration, post-harvest configuration, and query-routing tables. Do not report evaluation results or scheme fields without verified data.

### H. Paper section mapping

| Paper section | Repository evidence |
|---|---|
| Abstract | Verified architecture, corpus/index/model facts only |
| Introduction | Project purpose and target user from README/source; external motivation references required |
| II-A Data Collection and Knowledge Preparation | `build_general_corpus.py`, current CSV, with provenance qualifications |
| II-B Knowledge Base Construction and Vector Indexing | chunk builder, Sentence Transformers, FAISS artifact |
| II-C Retrieval-Augmented Generation | `GeneralRAG`, `ragClient`, species/topic filtering, post-harvest route |
| II-D Response Generation and Evidence Validation | `chatController`, prompts, evidence gates, LLM/fallback, reconciler |
| II-E JasmineSathi Decision-Support Modules | conversation memory, language, routing; government schemes NOT VERIFIED |
| II-F Pipeline Evaluation | tests only; Q1-Q5 and metrics missing |
| Related Work | External literature required |
| Experimental Setup | software/model/index facts; hardware/seeds/revisions missing |
| Results | Current corpus statistics are reportable; answer-quality/evaluation results missing |
| Case Studies | Must be derived from actual logged runs or supplied externally |
| Limitations | Missing provenance, evaluation, deployment, authority verification, and schema inconsistencies |
| Conclusion | Limit to verified implementation; do not claim efficacy or guarantees |

## 40. Bottom-Line Runtime Determination

The current architecture description matches the source code only if it describes **FAISS + Sentence Transformers + OpenRouter + MongoDB**, with a separate in-memory post-harvest hybrid route. It does not match the current runtime if it describes **ChromaDB, LangChain, Gemini, government-scheme recommendations, or a post-harvest FAISS index**.

The current `1,114 / 170 / 384-D / 127 / 27` general statistics are still correct for the checked-in artifacts. `GPT-4o-mini` through OpenRouter is the default configured runtime model, subject to the `OPENROUTER_MODEL` override and API-key availability. The government scheme module is not verified as implemented. Complete Q1-Q5 evaluation data is not present in the repository.
