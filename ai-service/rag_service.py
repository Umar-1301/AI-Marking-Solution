import sqlite3
import json
import os
from typing import List, Optional, Dict, Any

_HERE   = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(_HERE, "data", "exemplars.sqlite")


def _conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("""
        CREATE TABLE IF NOT EXISTS exemplars (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            question_number TEXT    NOT NULL,
            essay_text      TEXT    NOT NULL,
            score           INTEGER NOT NULL,
            max_marks       INTEGER NOT NULL,
            band            INTEGER,
            source          TEXT    NOT NULL DEFAULT '',
            embedding       TEXT    NOT NULL,
            created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)
    db.commit()
    return db


def _embed(text: str) -> List[float]:
    from llm_service import client
    resp = client.embeddings.create(
        model="text-embedding-3-small",
        input=text[:8000],
    )
    return resp.data[0].embedding


def _cosine(a: List[float], b: List[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    ma  = sum(x * x for x in a) ** 0.5
    mb  = sum(x * x for x in b) ** 0.5
    return dot / (ma * mb) if ma and mb else 0.0


def add_exemplar(
    essay_text: str,
    question_number: str,
    score: int,
    max_marks: int,
    band: Optional[int] = None,
    source: str = "",
) -> int:
    embedding = _embed(essay_text)
    db = _conn()
    cur = db.execute(
        "INSERT INTO exemplars "
        "(question_number, essay_text, score, max_marks, band, source, embedding) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (question_number, essay_text, score, max_marks, band, source, json.dumps(embedding)),
    )
    db.commit()
    db.close()
    return cur.lastrowid


def get_similar(
    essay_text: str,
    question_number: Optional[str] = None,
    n: int = 3,
) -> List[Dict[str, Any]]:
    db = _conn()
    if question_number:
        rows = db.execute(
            "SELECT id, question_number, essay_text, score, max_marks, band, source, embedding "
            "FROM exemplars WHERE question_number = ?",
            (question_number,),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT id, question_number, essay_text, score, max_marks, band, source, embedding "
            "FROM exemplars"
        ).fetchall()
    db.close()

    if not rows:
        return []

    query_emb = _embed(essay_text)
    scored = []
    for row in rows:
        emb = json.loads(row["embedding"])
        scored.append({
            "id":              row["id"],
            "question_number": row["question_number"],
            "essay_text":      row["essay_text"],
            "score":           row["score"],
            "max_marks":       row["max_marks"],
            "band":            row["band"],
            "source":          row["source"],
            "similarity":      _cosine(query_emb, emb),
        })

    scored.sort(key=lambda x: x["similarity"], reverse=True)
    return scored[:n]


def list_exemplars() -> List[Dict[str, Any]]:
    db = _conn()
    rows = db.execute(
        "SELECT id, question_number, score, max_marks, band, source, created_at "
        "FROM exemplars ORDER BY created_at DESC"
    ).fetchall()
    db.close()
    return [dict(row) for row in rows]


def delete_exemplar(exemplar_id: int) -> bool:
    db = _conn()
    result = db.execute("DELETE FROM exemplars WHERE id = ?", (exemplar_id,))
    db.commit()
    db.close()
    return result.rowcount > 0
