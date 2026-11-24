from langchain_ollama import OllamaEmbeddings
from langchain_chroma import Chroma
from langchain_core.documents import Document

import pymysql
import pymysql.cursors

import hashlib
import json
import os
import sys


# ============================================================
# PATHS AND MYSQL SETTINGS
# ============================================================

# Always use paths relative to this Python file.
# This avoids problems when server.js starts Python
# from a different working directory.

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DB_LOCATION = os.path.join(
    BASE_DIR,
    "chroma_langchain_db"
)

# server.js passes these in, so both always use the same database.
# The defaults match XAMPP: user "root" with no password.
# 127.0.0.1 is used instead of "localhost" to avoid IPv6 issues on Windows.

MYSQL_CONFIG = {
    "host": os.environ.get("DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("DB_PORT", "3306")),
    "user": os.environ.get("DB_USER", "root"),
    "password": os.environ.get("DB_PASSWORD", ""),
    "database": os.environ.get("DB_NAME", "unklab_library"),
    "charset": "utf8mb4",
    "cursorclass": pymysql.cursors.DictCursor
}


# ============================================================
# OLLAMA EMBEDDING MODEL
# ============================================================

embeddings = OllamaEmbeddings(
    model="mxbai-embed-large"
)


# ============================================================
# CHROMA DATABASE
# ============================================================

vector_store = Chroma(
    collection_name="library_books",
    persist_directory=DB_LOCATION,
    embedding_function=embeddings
)


# ============================================================
# LOAD LATEST BOOK DATA FROM MYSQL
# ============================================================

def load_library_books():
    """
    Read the latest rows from the MySQL "referenceBookData" table.
    This function is called whenever synchronization occurs,
    so the chatbot always sees the current library data.
    """

    connection = pymysql.connect(**MYSQL_CONFIG)

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT title, author, status, bookDescription "
                "FROM referenceBookData ORDER BY title, author"
            )
            rows = cursor.fetchall()
    finally:
        connection.close()

    books = []

    for row in rows:
        # Treat NULL columns as empty text instead of failing.
        book = {
            field: "" if row.get(field) is None else str(row[field])
            for field in ("title", "author", "status", "bookDescription")
        }

        # A book without a title cannot be identified; skip it.
        if not book["title"].strip():
            continue

        books.append(book)

    return books


def load_borrowed_books():
    """
    Read the books that are borrowed right now (MySQL "borrowedBook").
    Used when the chatbot is asked to list books, so a full list also
    shows the books that are out.
    """

    connection = pymysql.connect(**MYSQL_CONFIG)

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT title, author, status, bookDescription "
                "FROM borrowedBook ORDER BY title, author"
            )
            rows = cursor.fetchall()
    finally:
        connection.close()

    books = []

    for row in rows:
        book = {
            field: "" if row.get(field) is None else str(row[field])
            for field in ("title", "author", "status", "bookDescription")
        }

        if book["title"].strip():
            books.append(book)

    return books


# ============================================================
# CREATE A STABLE ID FOR EACH BOOK
# ============================================================

def get_book_id(book):
    """
    Generate a stable ID from the book's title and author.

    Editing the status or description will not change the ID.
    This allows Chroma to update the existing book instead
    of creating a duplicate.
    """

    identity = json.dumps(
        [
            book["title"].strip().casefold(),
            book["author"].strip().casefold()
        ],
        ensure_ascii=False
    )

    return hashlib.sha256(
        identity.encode("utf-8")
    ).hexdigest()


# ============================================================
# CONVERT A BOOK INTO A LANGCHAIN DOCUMENT
# ============================================================

def book_to_document(book):
    """
    Convert a row from the referenceBookData table into a searchable document.
    """

    return Document(
        page_content=(
            f"Title: {book['title']}\n"
            f"Author: {book['author']}\n"
            f"Status: {book['status']}\n"
            f"Description: {book['bookDescription']}"
        ),
        metadata={
            "title": book["title"],
            "author": book["author"],
            "status": book["status"]
        }
    )


# ============================================================
# SYNCHRONIZE THE MYSQL referenceBookData TABLE WITH CHROMA
# ============================================================

def sync_library_books():
    """
    Synchronize Chroma with the MySQL "referenceBookData" table.

    Automatically handles:
    1. New books.
    2. Removed books.
    3. Changed titles.
    4. Changed authors.
    5. Changed statuses.
    6. Changed descriptions.

    Unchanged books are not re-embedded.
    """

    # Read the latest rows from MySQL on every synchronization.
    books = load_library_books()

    # Build the latest book/document mapping.
    latest_documents = {}

    for book in books:
        book_id = get_book_id(book)

        # (title, author) is the table's primary key, but MySQL compares
        # it case-insensitively and ignores trailing spaces, so skip any
        # rows that would still map to the same Chroma ID.
        if book_id in latest_documents:
            continue

        latest_documents[book_id] = book_to_document(book)

    # Retrieve all existing Chroma records.
    existing = vector_store.get(
        include=["documents", "metadatas"]
    )

    existing_ids = existing["ids"]
    existing_contents = existing["documents"] or []

    # Map existing IDs to their stored document contents.
    existing_map = {
        book_id: content
        for book_id, content in zip(
            existing_ids,
            existing_contents
        )
    }

    latest_ids = set(latest_documents.keys())
    existing_id_set = set(existing_ids)

    # --------------------------------------------------------
    # A. DELETE BOOKS THAT NO LONGER EXIST IN MYSQL
    # --------------------------------------------------------

    removed_ids = list(
        existing_id_set - latest_ids
    )

    if removed_ids:
        vector_store.delete(ids=removed_ids)

    # --------------------------------------------------------
    # B. FIND NEW AND MODIFIED BOOKS
    # --------------------------------------------------------

    new_ids = []
    new_documents = []

    updated_ids = []
    updated_documents = []

    for book_id, document in latest_documents.items():

        new_content = document.page_content

        # The book does not exist in Chroma.
        if book_id not in existing_map:

            new_ids.append(book_id)
            new_documents.append(document)

        # The book exists, but one or more fields changed.
        elif existing_map[book_id] != new_content:

            updated_ids.append(book_id)
            updated_documents.append(document)

    # --------------------------------------------------------
    # C. ADD NEW BOOKS
    # --------------------------------------------------------

    if new_documents:
        vector_store.add_documents(
            documents=new_documents,
            ids=new_ids
        )

    # --------------------------------------------------------
    # D. UPDATE MODIFIED BOOKS
    # --------------------------------------------------------

    if updated_documents:
        vector_store.update_documents(
            ids=updated_ids,
            documents=updated_documents
        )

    # --------------------------------------------------------
    # E. REPORT SYNCHRONIZATION RESULTS
    # --------------------------------------------------------

    print(
        "[Library RAG] Synchronization complete. "
        f"Total books: {len(books)}, "
        f"Added: {len(new_ids)}, "
        f"Updated: {len(updated_ids)}, "
        f"Removed: {len(removed_ids)}",
        file=sys.stderr,
        flush=True
    )

    return {
        "total": len(books),
        "added": len(new_ids),
        "updated": len(updated_ids),
        "removed": len(removed_ids)
    }


# ============================================================
# INITIAL SYNCHRONIZATION
# ============================================================

# Synchronize when this module is imported.
# main.py will also synchronize before each question.

#
# If MySQL is not running yet, keep the chatbot process alive:
# main.py synchronizes again before every question.

try:
    sync_library_books()
except Exception as error:
    print(
        f"[Library RAG] Initial synchronization failed: {error}",
        file=sys.stderr,
        flush=True
    )


# ============================================================
# RETRIEVER
# ============================================================

retriever = vector_store.as_retriever(
    search_kwargs={
        "k": 5
    }
)
