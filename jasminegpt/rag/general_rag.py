"""
JasmineGPT — General Jasmine RAG Service
=========================================
Handles retrieval for the broad jasmine agricultural scientific knowledge base.
Uses the authentic Jasmine scientific corpus and FAISS vector index from the
original Google Colab project (/content/drive/MyDrive/Jasmine_Documents).

Embedding model: BAAI/bge-small-en-v1.5
Index: FAISS IndexFlatIP (384-dimensional normalized embeddings)
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

EMBED_MODEL_NAME = "BAAI/bge-small-en-v1.5"
TOP_K = 5

DEFAULT_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DEFAULT_FAISS_PATH = os.path.join(DEFAULT_DATA_DIR, "general_faiss.index")
DEFAULT_CHUNKS_PATH = os.path.join(DEFAULT_DATA_DIR, "general_chunks.csv")
DEFAULT_CHUNK_META_PATH = os.path.join(DEFAULT_DATA_DIR, "chunk_metadata.csv")
DEFAULT_DOC_META_PATH = os.path.join(DEFAULT_DATA_DIR, "metadata.csv")


def decompose_query(query: str) -> list[str]:
    """Create focused retrieval intents from a compound question."""
    normalized = re.sub(r"\s+", " ", query.strip())
    if not normalized:
        return []

    parts = re.split(
        r"\s+(?:ಮತ್ತು|ಹಾಗೂ)\s+|"
        r"\s+(?:and|also|as well as)\s+"
        r"(?=(?:how|what|which|why|where|when|can|could|ways?|factors?|"
        r"diseases?|ರೋಗ|ಹೇಗೆ|ಏನು|ಯಾವ|ರೈತರು))",
        normalized,
        flags=re.IGNORECASE,
    )
    parts = [part.strip(" ,;") for part in parts if part.strip(" ,;")]

    # Expand a broad factor request into outcome-specific retrieval intents.
    # The outcomes come from the user's wording; no agronomic factors are
    # invented here.
    factor_part = next(
        (part for part in parts if re.search(r"\bfactor|influence|affect|depend", part, re.I)),
        None,
    )
    outcomes = []
    factor_source = factor_part or normalized
    for term in ("flowering", "flower yield", "flower production"):
        if re.search(rf"\b{re.escape(term)}\b", factor_source, re.IGNORECASE):
            outcomes.append(term)
    if "flower yield" not in outcomes and re.search(r"\byield\b", factor_source, re.I):
        outcomes.append("yield")
    if "flower production" not in outcomes and re.search(r"\bproduction\b", factor_source, re.I):
        outcomes.append("production")
    if factor_part and len(outcomes) > 1:
        subject_match = re.search(r"\bin\s+(.+?)(?:\?|$)", factor_part, re.IGNORECASE)
        subject = subject_match.group(1).strip(" ,") if subject_match else "jasmine"
        factor_intents = [
            f"Factors affecting {outcome} in {subject or 'jasmine'}"
            for outcome in outcomes
        ]
        parts = factor_intents + [
            part for part in parts if part != factor_part
        ]

    # Resolve a management follow-up such as "how can they be managed?" to
    # the domain named in the preceding intent.
    if len(parts) > 1 and re.search(r"\bmanaged|manage|improve|improving\b", parts[-1], re.I):
        preceding = " ".join(parts[:-1])
        if re.search(r"\bdisease|pest|nutrition|irrigation|pruning|fertiliz|fertiliser|nutrient|nitrogen|phosphorus|potassium|npk|manure\b", preceding, re.I):
            parts[-1] = re.sub(
                r"^(?:how\s+)?can\s+(?:they|it)\s+be\s+(?:managed|improved)\??$",
                lambda _: f"Management practices for {re.sub(r'^what\s+', '', preceding.rstrip('?'), flags=re.I)}",
                parts[-1],
                flags=re.IGNORECASE,
            )
        if re.match(r"^how\s+can\s+(?:farmers?|growers?)\s+improv", parts[-1], re.I):
            subject_match = re.search(r"\bin\s+([A-Za-z]+)", normalized, re.IGNORECASE)
            subject = subject_match.group(1).strip(" ,") if subject_match else "jasmine"
            parts[-1] = re.sub(
                r"^how\s+can\s+(?:farmers?|growers?)\s+",
                "Practices or treatments reported to ",
                parts[-1],
                flags=re.IGNORECASE,
            )
            parts[-1] = f"{parts[-1].rstrip('?')} in {subject}"
    elif len(parts) > 1 and re.search(r"\bimprov(?:e|es|ing)\b", parts[-1], re.I):
        subject_match = re.search(r"\bin\s+([A-Za-z]+)", normalized, re.IGNORECASE)
        subject = subject_match.group(1).strip(" ,") if subject_match else "jasmine"
        parts[-1] = re.sub(
            r"^(?:how\s+can\s+)?(?:farmers?|growers?)\s+",
            "Practices or treatments reported to ",
            parts[-1],
            flags=re.IGNORECASE,
        )
        parts[-1] = f"{parts[-1].rstrip('?')} in {subject}"

    return list(dict.fromkeys(parts)) if parts else [normalized]


def detect_category(query: str) -> str | None:
    """Auto category detection matching the original Colab notebook."""
    q = query.lower()

    if any(x in q for x in ["pruning", "off season", "defoliation", "paclobutrazol"]):
        return "Pruning"
    elif any(x in q for x in ["fertilizer", "fertiliser", "fertiliz", "fertilis", "fertigation", "npk", "micronutrient", "nutrient", "manure", "nitrogen", "phosphorus", "potassium", "urea"]):
        return "Nutrition"
    elif any(x in q for x in ["drip", "irrigation", "water", "soil moisture", "water stress"]):
        return "Irrigation"
    elif any(x in q for x in [
        "bud worm", "bud borer", "leaf web worm",
        "thrips", "mite", "aphid", "whitefly",
        "blossom midge", "pest", "insect"
    ]):
        return "Pest"
    elif any(x in q for x in ["virus", "leaf spot", "rust", "anthracnose", "disease", "wilt"]):
        return "Disease"
    elif any(x in q for x in ["shelf life", "storage", "packaging", "transport", "post harvest"]):
        return "PostHarvest"

    return None


def _has_unambiguous_query_signal(query: str, results: pd.DataFrame) -> bool:
    """Avoid treating unrelated nearest neighbours as evidence.

    This is an evidence validation check, not a similarity threshold: it only
    applies when no known domain category was detected.
    """
    stop_words = {
        "what", "which", "where", "when", "does", "this", "that", "with",
        "from", "about", "into", "for", "the", "and", "how", "can", "are",
        "is", "in", "on", "of", "to", "a", "an", "jasmine",
    }
    query_terms = {
        token for token in re.findall(r"[a-z]{4,}", query.lower())
        if token not in stop_words
    }
    if not query_terms:
        return True
    corpus_text = " ".join(
        results.get("text", pd.Series(dtype=str)).fillna("").astype(str).tolist()
        + results.get("category", pd.Series(dtype=str)).fillna("").astype(str).tolist()
    ).lower()
    return any(re.search(rf"\b{re.escape(term)}\b", corpus_text) for term in query_terms)


def _evidence_relation(query: str, row: pd.Series) -> str:
    """Classify a chunk by topic overlap, without treating similarity as proof."""
    stop_words = {
        "what", "which", "where", "when", "does", "this", "that", "with",
        "from", "about", "into", "for", "the", "and", "how", "can", "are",
        "is", "in", "on", "of", "to", "a", "an", "factors", "affecting",
    }
    terms = {
        token for token in re.findall(r"[a-z]{4,}", query.lower())
        if token not in stop_words and token != "jasmine"
    }
    searchable = " ".join(
        str(row.get(column, "")) for column in ("text", "filename", "category")
    ).lower()
    return "DIRECT_EVIDENCE" if any(term in searchable for term in terms) else "RELATED_EVIDENCE"


KNOWN_TITLES = {
    "TH-3583.pdf": "Effect of Plant Population and Nitrogen Levels on Growth and Flower Yield of Jasminum grandiflorum L.",
    "D350.pdf": "Standardization of Irrigation and Fertigation Techniques in Jasmine (Jasminum grandiflorum) var CO. 2",
    "Varsha, A. P..pdf": "Standardization of Fertigation Schedule for Growth, Yield and Quality of Jasmine [Jasminum multiflorum (Burm. f.) Andrews] under Eastern Dry Zone of Karnataka",
    "4002.pdf": "To Study the Adoption of Jasmine Flower Growers in Pune District",
    "Full Thesis_31816.pdf": "Effect of Spacing and Nitrogen Levels on Growth, Yield and Flower Quality of Jasmine (Jasminum sambac Ait.) Cv. 'Double Mogra'",
    "PHM_PHTRM0210184_PHM of FVF_Sawant Siddhi Kiran_T07610.pdf": "Studies on Packaging and Storage Behaviour of Champaca (Michelia champaca L.)",
    "Th-5690.pdf": "Packaging of Chemically Treated Jasmine Flowers (Jasminum auriculatum and Jasminum grandiflorum) for Extending Shelf Life",
    "Th-5550.pdf": "Characterisation of Important Cultivars of Jasminum Species Using Molecular Markers",
    "content.pdf": "Response of Jasmine (Jasminum auriculatum) to Biofertilizer Application",
    "th9706.pdf": "Response of Jasmine (Jasminum auriculatum) to Biofertilizer Application",
    "th8819.pdf": "Hormonal Regulation of Growth and Yield in Jasmine (Jasminum auriculatum Vahl.)",
    "T1111.pdf": "Seasonal Incidence and Evolving an IPM Strategy for Erineum Mite on Jasminum auriculatum Vahl.",
    "TH-4900.pdf": "Studies on Growth, Flowering and Yield of Jasminum sambac L.",
    "TH-2695.pdf": "Vegetative Propagation Studies in Jasminum sambac Ait.",
}


class GeneralRAG:
    def __init__(self) -> None:
        self._ready = False
        self.chunks_df: pd.DataFrame | None = None
        self.index = None
        self.embedder = None
        self._faiss_path = os.getenv("GENERAL_FAISS_INDEX_PATH", DEFAULT_FAISS_PATH)
        self._chunks_csv = os.getenv("GENERAL_CHUNKS_CSV_PATH", DEFAULT_CHUNKS_PATH)
        self._chunk_meta_csv = DEFAULT_CHUNK_META_PATH
        self._doc_meta_csv = DEFAULT_DOC_META_PATH

    def initialize(self) -> None:
        """Load original persistent FAISS index and chunk metadata from disk."""
        logger.info("Initializing GeneralRAG from original scientific corpus artifacts...")
        try:
            import faiss
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise RuntimeError(
                "faiss or sentence-transformers not installed."
            ) from exc

        # Resolve chunks CSV (prefer general_chunks.csv, fallback to chunk_metadata.csv)
        csv_path = self._chunks_csv if os.path.exists(self._chunks_csv) else self._chunk_meta_csv
        if not os.path.exists(csv_path):
            raise FileNotFoundError(
                f"Original General RAG chunk metadata not found at {csv_path} or {self._chunk_meta_csv}."
            )

        if not os.path.exists(self._faiss_path):
            raise FileNotFoundError(
                f"Original General RAG FAISS index not found at {self._faiss_path}."
            )

        logger.info("Loading chunk metadata from: %s", csv_path)
        self.chunks_df = pd.read_csv(csv_path)

        logger.info("Loading FAISS index from: %s", self._faiss_path)
        self.index = faiss.read_index(self._faiss_path)

        if self.index.ntotal != len(self.chunks_df):
            logger.warning(
                "FAISS vector count (%d) differs from metadata rows (%d)",
                self.index.ntotal,
                len(self.chunks_df),
            )

        logger.info("Loading general RAG embedding model: %s", EMBED_MODEL_NAME)
        self.embedder = SentenceTransformer(EMBED_MODEL_NAME)

        self._ready = True
        logger.info(
            "GeneralRAG ready. %d vectors indexed from original corpus (%d dimensions).",
            self.index.ntotal,
            self.index.d,
        )

    def retrieve(
        self,
        query: str,
        top_k: int = TOP_K,
        species: str = "Jasminum sambac",
        allow_cross_species: bool = False,
    ) -> dict[str, Any]:
        """
        Retrieve top-k chunks using verified metadata layer and FAISS index.
        Enforces target species integrity:
        - Only Jasminum sambac and Jasminum auriculatum are target species.
        - Non-target species (J. grandiflorum, J. multiflorum, etc.) are never
          returned as Jasminum sambac.
        - If cross-species evidence is included, it is explicitly flagged.
        """
        assert self._ready, "Call initialize() first"

        category = detect_category(query)

        # 1. Encode query with normalized embeddings
        t0 = time.perf_counter()
        q_emb = self.embedder.encode([query], normalize_embeddings=True)
        q_emb = np.array(q_emb).astype("float32")
        t_emb = time.perf_counter()

        # 2. Search candidate pool in FAISS index
        candidate_k = min(len(self.chunks_df), max(top_k * 8, 40))
        scores, ids = self.index.search(q_emb, candidate_k)
        t_search = time.perf_counter()

        valid_indices = [idx for idx in ids[0] if 0 <= idx < len(self.chunks_df)]
        valid_scores = [scores[0][i] for i, idx in enumerate(ids[0]) if 0 <= idx < len(self.chunks_df)]

        results = self.chunks_df.iloc[valid_indices].copy()
        results["score"] = valid_scores
        results["is_cross_species"] = False

        retrieval_metrics = {
            "pipeline": "general_faiss",
            "embedding_model": EMBED_MODEL_NAME,
            "score_metric": "Cosine Similarity (FAISS IndexFlatIP)",
            "candidate_k": candidate_k,
            "initial_candidate_count": len(valid_indices),
            "embedding_latency_ms": round((t_emb - t0) * 1000, 2),
            "vector_search_latency_ms": round((t_search - t_emb) * 1000, 2),
            "total_retrieval_latency_ms": round((t_search - t0) * 1000, 2),
        }

        if category is None and not _has_unambiguous_query_signal(query, results):
            return {
                "route": "GENERAL_RAG",
                "top_score": 0.0,
                "target_species": species,
                "category": category,
                "direct_evidence_found": False,
                "cross_species_used": False,
                "status_message": "No evidence matched the subject of the question.",
                "chunks": [],
                "retrieval_metrics": retrieval_metrics,
            }

        # 3. Target species filter
        direct_evidence_found = False
        cross_species_used = False
        status_message = ""

        # Check if direct target species records exist
        is_target = pd.Series(True, index=results.index)
        if species:
            is_target = (
                (results.get("target_status", "TARGET_SPECIES") == "TARGET_SPECIES") &
                (results["species"].str.contains(species, case=False, na=False))
            )

        direct_subset = results[is_target].copy()

        # 4. Category filter
        if category and "category" in results.columns:
            cat_direct = direct_subset[direct_subset["category"].str.lower() == category.lower()] if not direct_subset.empty else pd.DataFrame()
            if not cat_direct.empty:
                results = cat_direct
                direct_evidence_found = True
                status_message = f"Found direct {species} evidence in category '{category}'."
            elif not direct_subset.empty:
                # Direct target species evidence exists in corpus, but not specifically in this category
                cat_cross = results[
                    (results["category"].str.lower() == category.lower()) &
                    (results.get("target_status", "") != "TARGET_SPECIES")
                ].copy()
                if not cat_cross.empty and allow_cross_species:
                    cat_cross["is_cross_species"] = True
                    results = cat_cross
                    cross_species_used = True
                    direct_evidence_found = False
                    status_message = (
                        f"No direct '{species}' evidence found in category '{category}'. "
                        f"Returning cross-species comparative evidence explicitly labeled."
                    )
                else:
                    results = direct_subset
                    direct_evidence_found = True
                    status_message = f"Found direct {species} evidence in general agronomy/cultivation."
            else:
                # No direct results for species in pool
                cat_cross = results[results["category"].str.lower() == category.lower()].copy()
                if not cat_cross.empty and allow_cross_species:
                    cat_cross["is_cross_species"] = True
                    results = cat_cross
                    cross_species_used = True
                    direct_evidence_found = False
                    status_message = (
                        f"No direct '{species}' evidence found in category '{category}'. "
                        f"Returning cross-species comparative evidence explicitly labeled."
                    )
                else:
                    results = pd.DataFrame()
                    status_message = f"No direct evidence found for '{species}' in category '{category}'."
        else:
            if not direct_subset.empty:
                results = direct_subset
                direct_evidence_found = True
                status_message = f"Found {len(direct_subset)} direct evidence records for {species}."
            elif allow_cross_species:
                results["is_cross_species"] = True
                cross_species_used = True
                direct_evidence_found = False
                status_message = f"No direct evidence found for '{species}'. Returning cross-species comparative evidence."
            else:
                results = pd.DataFrame()
                status_message = f"No direct evidence found for '{species}'."

        if not results.empty:
            # 5. Keyword Boost (exact pattern from Colab notebook)
            ql = query.lower()
            if "bud worm" in ql or "bud borer" in ql:
                boost = results["filename"].str.contains(
                    "bio-efficacy|biorational|bud worm|bud borer",
                    case=False,
                    na=False,
                )
                results.loc[boost, "score"] += 0.10

            # 6. Sort and drop duplicates by filename
            results = results.sort_values("score", ascending=False)
            results = results.drop_duplicates(subset=["filename"])
            top = results.head(top_k)
        else:
            top = pd.DataFrame()

        # 7. Format structured evidence records (do not invent missing metadata)
        chunks: list[dict[str, Any]] = []
        for _, r in top.iterrows():
            filename_str = str(r["filename"])
            title_str = KNOWN_TITLES.get(filename_str)

            year_val = None
            year_match = re.search(r"\b(19\d{2}|20\d{2})\b", filename_str)
            if year_match:
                try:
                    year_val = int(year_match.group(1))
                except Exception:
                    year_val = None

            is_cross = bool(r.get("is_cross_species", False))
            cross_note = r.get("cross_species_note")
            if is_cross and not cross_note:
                cross_note = f"Cross-species evidence from {r.get('real_species', r.get('species'))}; for comparative reference only."

            chunks.append({
                "chunk_id": str(r["chunk_id"]),
                "score": float(r["score"]),
                "hybrid_score": float(r["score"]),  # backwards compatibility
                "text": str(r["text"]),
                "title": title_str,
                "species": str(r["species"]) if pd.notna(r.get("species")) else "Jasminum sambac",
                "real_species": str(r["real_species"]) if pd.notna(r.get("real_species")) else str(r.get("species", "")),
                "target_status": str(r["target_status"]) if pd.notna(r.get("target_status")) else "TARGET_SPECIES",
                "is_cross_species": is_cross,
                "cross_species_note": str(cross_note) if cross_note else None,
                "category": str(r["category"]) if pd.notna(r.get("category")) else "Cultivation",
                "keyword": None,
                "year": year_val,
                "doi": None,
                "url": None,
                "source": str(r["source"]) if pd.notna(r.get("source")) else "KrishiKosh",
                "filename": filename_str,
                "page": None,
                "evidence_relation": _evidence_relation(query, r),
            })

        return {
            "route": "GENERAL_RAG",
            "top_score": float(top["score"].max()) if len(top) else 0.0,
            "target_species": species,
            "category": category,
            "direct_evidence_found": direct_evidence_found,
            "cross_species_used": cross_species_used,
            "status_message": status_message,
            "chunks": chunks,
            "retrieval_metrics": retrieval_metrics,
        }

    def retrieve_multi_query(
        self,
        query: str,
        top_k: int = TOP_K,
        species: str = "Jasminum sambac",
        allow_cross_species: bool = False,
    ) -> dict[str, Any]:
        """Decompose a query and retrieve a separate evidence packet per part."""
        sub_questions = decompose_query(query)
        packets: list[dict[str, Any]] = []
        all_chunks: list[dict[str, Any]] = []

        if os.getenv("RAG_DEBUG_RETRIEVAL") == "1":
            logger.info("[ORIGINAL QUERY] %s", query)
            logger.info("[DECOMPOSED QUESTIONS] %s", sub_questions)

        for index, sub_question in enumerate(sub_questions, 1):
            if os.getenv("RAG_DEBUG_RETRIEVAL") == "1":
                logger.info("[RETRIEVAL QUERY FOR SUBQUESTION %s] %s", index, sub_question)
            result = self.retrieve(
                sub_question,
                top_k=top_k,
                species=species,
                allow_cross_species=allow_cross_species,
            )
            if any(
                chunk.get("evidence_relation") == "DIRECT_EVIDENCE"
                for chunk in result["chunks"]
            ):
                evidence_status = "DIRECT_EVIDENCE"
                evidence_message = "Direct evidence was retrieved for this sub-question."
            elif result["chunks"]:
                evidence_status = "RELATED_EVIDENCE"
                evidence_message = "Only related or cross-species evidence was retrieved for this sub-question."
            else:
                evidence_status = "INSUFFICIENT_EVIDENCE"
                evidence_message = (
                    "The current JasmineGPT knowledge base does not contain sufficient "
                    "evidence to answer this specific part."
                )

            # Keep the strongest chunk for each source document in this packet.
            packet_chunks = [
                {**chunk, "sub_question_id": f"q{index}"}
                for chunk in sorted(
                    result["chunks"],
                    key=lambda chunk: float(chunk.get("score", 0.0)),
                    reverse=True,
                )
            ]
            packet_chunks = list({
                chunk["filename"]: chunk for chunk in packet_chunks
            }.values())
            if os.getenv("RAG_DEBUG_RETRIEVAL") == "1":
                for chunk in packet_chunks:
                    logger.info(
                        "[RETRIEVED DOCUMENT ID] %s [%s] %s "
                        "[SOURCE] %s [CATEGORY] %s [SCORE] %.4f [SELECTED] yes [REASON] "
                        "top source for intent",
                        chunk["chunk_id"],
                        "DOCUMENT TITLE" if chunk.get("title") else "SOURCE DOCUMENT",
                        chunk.get("title") or chunk["filename"],
                        chunk.get("source"), chunk.get("category"),
                        float(chunk.get("score", 0.0)),
                    )
            all_chunks.extend(packet_chunks)
            packets.append({
                "id": f"q{index}",
                "question": sub_question,
                "evidence_status": evidence_status,
                "evidence_message": evidence_message,
                "top_score": result["top_score"],
                "chunks": packet_chunks,
            })

        total_candidates = sum(
            p.get("chunks", []) and len(p.get("chunks", [])) or 0 for p in packets
        )
        embedding_time_total = sum(
            p.get("retrieval_metrics", {}).get("embedding_latency_ms", 0.0) for p in packets
        )
        search_time_total = sum(
            p.get("retrieval_metrics", {}).get("vector_search_latency_ms", 0.0) for p in packets
        )
        retrieval_time_total = sum(
            p.get("retrieval_metrics", {}).get("total_retrieval_latency_ms", 0.0) for p in packets
        )

        return {
            "route": "GENERAL_RAG",
            "query": query,
            "is_multi_query": len(sub_questions) > 1,
            "sub_questions": packets,
            # Keep the legacy fields populated for existing clients.
            "chunks": all_chunks,
            "top_score": max((p["top_score"] for p in packets), default=0.0),
            "target_species": species,
            "direct_evidence_found": any(
                p["evidence_status"] == "DIRECT_EVIDENCE" for p in packets
            ),
            "cross_species_used": any(
                any(c.get("is_cross_species") for c in p["chunks"]) for p in packets
            ),
            "status_message": "Evidence retrieved independently for each sub-question.",
            "retrieval_metrics": {
                "pipeline": "general_faiss",
                "embedding_model": EMBED_MODEL_NAME,
                "score_metric": "Cosine Similarity (FAISS IndexFlatIP)",
                "sub_questions_count": len(sub_questions),
                "initial_candidate_count": sum(p.get("retrieval_metrics", {}).get("initial_candidate_count", 0) for p in packets),
                "embedding_latency_ms": round(embedding_time_total, 2),
                "vector_search_latency_ms": round(search_time_total, 2),
                "total_retrieval_latency_ms": round(retrieval_time_total, 2),
            },
        }
