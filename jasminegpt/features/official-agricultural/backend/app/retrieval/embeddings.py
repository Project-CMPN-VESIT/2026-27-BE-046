from sentence_transformers import SentenceTransformer


MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


model = SentenceTransformer(MODEL_NAME)


def create_embeddings(texts):
    """
    Convert a list of text chunks into embeddings.
    """

    embeddings = model.encode(
        texts,
        show_progress_bar=True
    )

    return embeddings.tolist()


def create_embedding(text):
    """
    Convert a single text into an embedding.
    """

    embedding = model.encode(text)

    return embedding.tolist()