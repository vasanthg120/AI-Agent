import uuid
from functools import lru_cache

from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels

from app.config import settings
from app.rag.embeddings import vector_size


@lru_cache
def get_client() -> QdrantClient:
    return QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key or None)


_collection_ready = False


def ensure_collection() -> None:
    global _collection_ready
    if _collection_ready:
        return

    client = get_client()
    if not client.collection_exists(settings.qdrant_collection):
        client.create_collection(
            collection_name=settings.qdrant_collection,
            vectors_config=qmodels.VectorParams(
                size=vector_size(), distance=qmodels.Distance.COSINE
            ),
        )

    # Filtered search/update degrades to a full scan — or, for set_payload
    # and delete's points_selector filters, is outright rejected by Qdrant —
    # without a payload index on the filtered fields. document_id is filtered
    # on by reassign_owner/delete_by_document_id (role activation/deletion).
    # organization_id backs Finance's real per-tenant scoping (app.rag.retriever's
    # _finance_document_filter) — harmless for older points that lack it; a
    # keyword index simply never matches them on that field, which is
    # correct, since they were never org-scoped to begin with.
    indexed = set(client.get_collection(settings.qdrant_collection).payload_schema)
    for field in ("user_id", "source_type", "document_id", "organization_id"):
        if field not in indexed:
            client.create_payload_index(
                collection_name=settings.qdrant_collection,
                field_name=field,
                field_schema=qmodels.PayloadSchemaType.KEYWORD,
            )

    _collection_ready = True


def upsert_points(points: list[qmodels.PointStruct]) -> None:
    ensure_collection()
    get_client().upsert(collection_name=settings.qdrant_collection, points=points)


def upsert_chunks(
    document_id: str,
    user_id: str,
    filename: str,
    chunks: list[str],
    vectors: list[list[float]],
    *,
    source_type: str = "document",
    organization_id: str | None = None,
) -> None:
    # source_type/organization_id both default to today's exact behavior —
    # every existing caller (roles.py, documents.py) is byte-for-byte
    # unaffected. Finance is the first caller to pass organization_id, since
    # unlike generic personal uploads (private, user_id-only) or CRM's
    # deployment-wide "*" bucket, finance documents need real per-tenant
    # scoping (see app.rag.retriever's _finance_document_filter).
    points = [
        qmodels.PointStruct(
            id=str(uuid.uuid4()),
            vector=vector,
            payload={
                "source_type": source_type,
                "document_id": document_id,
                "user_id": user_id,
                "filename": filename,
                "chunk_index": i,
                "text": chunk,
                **({"organization_id": organization_id} if organization_id else {}),
            },
        )
        for i, (chunk, vector) in enumerate(zip(chunks, vectors))
    ]
    upsert_points(points)


def reassign_owner(document_id: str, new_user_id: str) -> None:
    """Rewrites user_id for every point of document_id, no re-embedding —
    used to promote a draft role's privately-owned source doc to org-wide
    ("*") on activation."""
    ensure_collection()
    get_client().set_payload(
        collection_name=settings.qdrant_collection,
        payload={"user_id": new_user_id},
        points=qmodels.Filter(
            must=[qmodels.FieldCondition(key="document_id", match=qmodels.MatchValue(value=document_id))]
        ),
    )


def delete_by_document_id(document_id: str) -> None:
    """Purges all points for a document — abandoned drafts, or any role
    (draft or active) being deleted."""
    ensure_collection()
    get_client().delete(
        collection_name=settings.qdrant_collection,
        points_selector=qmodels.Filter(
            must=[qmodels.FieldCondition(key="document_id", match=qmodels.MatchValue(value=document_id))]
        ),
    )


def search(
    vector: list[float],
    top_k: int = 5,
    query_filter: qmodels.Filter | None = None,
) -> list[dict]:
    ensure_collection()
    results = get_client().query_points(
        collection_name=settings.qdrant_collection,
        query=vector,
        limit=top_k,
        query_filter=query_filter,
    ).points
    return [{"score": r.score, **r.payload} for r in results]
