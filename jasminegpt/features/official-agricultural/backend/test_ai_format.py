import requests
import json
import sys
import os

sys.path.insert(0, os.path.abspath("."))
from app.config.settings import OPENROUTER_API_KEY, OPENROUTER_MODEL
from app.retrieval.rag_service import get_research_evidence

chunks = get_research_evidence("What fertilizer should I use to improve flowering in jasmine?")[:3]

papers_text = ""
for c in chunks:
    papers_text += f"\nPaper ID: {c['chunk_id']}\nTitle: {c['title']}\nRaw Text: {c['text'][:700]}\n---"

prompt = f"""You are an agricultural AI assistant.
Given the following scientific research paper excerpts retrieved for the question "What fertilizer should I use to improve flowering in jasmine?", clean up OCR artifacts, disjointed text, or spaced letters, and format clean, informative points for farmers.

Return a JSON object with a "papers" key containing a list of objects with:
- "chunk_id": the matching chunk_id
- "clean_title": clean readable title
- "key_points": list of 2 to 3 concise, clear, highly readable bullet points explaining key findings, treatments, or recommendations

Input papers:
{papers_text}
"""

response = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    },
    json={
        "model": OPENROUTER_MODEL,
        "temperature": 0.2,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"}
    },
    timeout=30
)

print("Status:", response.status_code)
data = response.json()
print(json.dumps(json.loads(data["choices"][0]["message"]["content"]), indent=2))
