"""OpenRouter formatter for JasmineSathi — constrained to retrieved verified context."""
from __future__ import annotations

import requests

from app.config.settings import (
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL,
    OPENROUTER_TIMEOUT_SECONDS,
)

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

SYSTEM_PROMPT = """You are JasmineSathi, a careful agricultural information assistant for Indian jasmine and flower farmers.

Your job is to inspect the retrieved evidence, reject irrelevant evidence, and then write a useful answer. Retrieved text is not automatically trustworthy or relevant merely because it was returned by search.

EVIDENCE AND RELEVANCE RULES:
1. First compare every result with the user's exact question. Use a result only when it directly supports the question's crop, topic, location, or requested action.
2. Ignore unrelated, duplicated, fragmentary, OCR-corrupted, or weakly connected chunks. Never force every retrieved result into the answer.
3. Give official government or institutional information priority for schemes, subsidies, eligibility, applications, costs, deadlines, and required documents.
4. Scientific research is supporting evidence, not an official scheme or entitlement. Clearly label it as research and do not present experimental findings as mandatory government advice.
5. Use only facts supported by the retained evidence. Do not invent subsidy amounts, eligibility criteria, pesticide names, scheme names, application steps, dates, or URLs. You may use your general reasoning to organize and explain the supplied facts, but not to add unsupported facts.
6. If the evidence is insufficient, say exactly what is missing and direct the farmer to verify the relevant official source page. Do not guess.

ANSWER STYLE:
7. Write in simple, clear English with complete sentences that make sense to a farmer.
8. Use this structure whenever the information is available:
    Direct answer:
    Official information:
    What the farmer should do:
    How to use the official source:
    Scientific research evidence:
9. Under Official information, use numbered points. Each point must be a complete sentence and should explain the condition or action, not just copy a fragment.
10. Under What the farmer should do, give practical numbered steps supported by the evidence. Mention when the farmer should contact the relevant department or verify local eligibility.
11. Under How to use the official source, explain which displayed official source to open, what title or keyword to search on that page, and what details to verify. If a link opens a portal with multiple documents or a form, tell the farmer how to identify the correct document, read its eligibility and required-information sections, and use the portal's official instructions before submitting anything. Explain that the answer is a guide and the official document controls the final decision. Do not print raw URLs because the application displays clickable official links separately.
12. Under Scientific research evidence, include only directly relevant studies. Rewrite fragmented source text into two or three complete, concise sentences per study, and explain how the finding may help the farmer. If no research is relevant, omit this section.
13. Do not mention retrieval, chunks, similarity scores, prompts, or internal system processing in the farmer-facing answer.
14. Focus on jasmine, floriculture, and flower farming in India."""


def _build_context(
    results: list[dict],
    query_info: dict,
    rag_chunks: list[dict] | None = None,
) -> str:
    """Build structured context sent to OpenRouter from both existing results and RAG research chunks."""
    sections = []

    # Metadata headers
    header_lines = []
    if query_info.get("category"):
        header_lines.append(f"Detected topic: {query_info['category'].replace('_', ' ').title()}")
    if query_info.get("location"):
        header_lines.append(f"Detected location: {query_info['location']}")
    if header_lines:
        sections.append("\n".join(header_lines))

    # 1. Existing Search Results
    if results:
        res_lines = ["=== EXISTING SEARCH RESULTS ==="]
        for number, result in enumerate(results[:5], start=1):
            meta = result.get("metadata", {})
            res_lines.extend([
                f"RESULT {number}:",
                f"Source: {meta.get('source_name', 'Unknown')}",
                f"Title: {meta.get('page_title', 'Untitled')}",
                f"Section: {meta.get('section', 'General Information')}",
                f"Content: {result.get('text', '').strip()}",
                "---",
            ])
        sections.append("\n".join(res_lines))

        # 2. URI Information
        uri_lines = ["=== URI INFORMATION ==="]
        for number, result in enumerate(results[:5], start=1):
            meta = result.get("metadata", {})
            page_url = meta.get("page_url", "")
            if page_url:
                uri_lines.append(f"- {meta.get('source_name', 'Official')}: {page_url} ({meta.get('page_title', '')})")
        if len(uri_lines) > 1:
            sections.append("\n".join(uri_lines))

    # 3. RAG Research Evidence
    if rag_chunks:
        rag_lines = ["=== RAG RESEARCH EVIDENCE ==="]
        for number, chunk in enumerate(rag_chunks[:5], start=1):
            title = chunk.get("title") or chunk.get("filename", "Research Paper")
            species = chunk.get("species", "")
            year = f" ({chunk['year']})" if chunk.get("year") else ""
            cross_note = f" Note: {chunk['cross_species_note']}" if chunk.get("is_cross_species") else ""
            rag_lines.extend([
                f"STUDY {number}: {title}{year}",
                f"Species: {species} | Source: {chunk.get('source', 'KrishiKosh')}{cross_note}",
                f"Key findings: {chunk.get('text', '').strip()}",
                "---",
            ])
        sections.append("\n".join(rag_lines))

    return "\n\n".join(sections)


def generate_openrouter_answer(
    question: str,
    results: list[dict],
    query_info: dict | None = None,
    rag_chunks: list[dict] | None = None,
) -> str | None:
    """Return a formatted farmer-friendly answer using existing results and RAG research chunks."""
    if not OPENROUTER_API_KEY or OPENROUTER_API_KEY.startswith("your_"):
        return None

    if not results and not rag_chunks:
        return None

    context = _build_context(results, query_info or {}, rag_chunks=rag_chunks)
    user_prompt = (
        f"USER QUESTION:\n{question}\n\n"
        f"CONTEXT INFORMATION:\n{context}\n\n"
        "INSTRUCTION:\n"
        "Work through the evidence before writing: classify each item as relevant or irrelevant, silently discard irrelevant items, and use only the relevant items. "
        "Then produce the structured farmer-facing answer required by the system instructions. "
        "Rewrite source fragments into complete sentences and explain how the farmer can use the displayed official source links."
    )

    response = requests.post(
        OPENROUTER_CHAT_URL,
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "JasmineSathi - India Flower Farmer Platform",
        },
        json={
            "model": OPENROUTER_MODEL,
            "temperature": 0.1,
            "max_tokens": 800,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=OPENROUTER_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    return content.strip() if content else None

