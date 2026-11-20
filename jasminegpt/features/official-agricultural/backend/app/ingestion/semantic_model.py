from sentence_transformers import SentenceTransformer


MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


print("Loading semantic model...")

model = SentenceTransformer(MODEL_NAME)

print("Semantic model loaded.")