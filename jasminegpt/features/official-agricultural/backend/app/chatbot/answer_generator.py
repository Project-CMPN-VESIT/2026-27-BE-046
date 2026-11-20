def generate_answer(query: str, results: list[dict]) -> str:
    if not results:
        return "I could not find enough trusted information in the current knowledge base. Please try a more specific question."
    parts = ["Here is the most relevant information from trusted sources:"]
    for result in results[:3]:
        metadata = result.get("metadata", {})
        label = metadata.get("page_title") or metadata.get("source_name") or "Official information"
        text = " ".join(result.get("text", "").split())
        preview = text[:700].rsplit(" ", 1)[0] if len(text) > 700 else text
        parts.append(f"\n{label} ({metadata.get('section', 'General Information')}):\n{preview}")
    return "\n".join(parts)
