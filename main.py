from langchain_ollama.llms import OllamaLLM
from langchain_core.prompts import ChatPromptTemplate

from vector import (
    retriever,
    sync_library_books,
    load_library_books,
    load_borrowed_books
)

import re
import sys
import json


# ============================================================
# OLLAMA AI MODEL
# ============================================================

# num_ctx: the default context window (2048 tokens in many Ollama
# versions) is too small to hold a long list of books, so books at the
# end were silently cut off. num_predict=-1 lets the answer be as long
# as it needs to be instead of stopping part-way through a list.

model = OllamaLLM(
    model="llama3.2",
    num_ctx=8192,
    num_predict=-1
)


# ============================================================
# "LIST THE BOOKS" QUESTIONS
# ============================================================
# The retriever only returns the 5 closest books, so the model could
# never list more than a handful. For list questions the chatbot now:
#   * answers "list all (white/science/reference room) books" directly
#     from MySQL, so every book is always included, and
#   * for lists on a topic ("list books about genetics"), gives the model
#     every book (short descriptions) and asks it to list all matches.

LIST_PATTERN = re.compile(
    r"\b(list|lists|listing|enumerate|all|every|everything|"
    r"how many|what books|which books|what are the books|"
    r"what research articles|which research articles)\b",
    re.IGNORECASE
)

ROOM_KEYWORDS = {
    "white": "white",
    "science": "science",
    "reference": "reference",
    "research": "reference"
}

# Words that do not describe a topic. If nothing else is left in the
# question, the user wants a plain list of all (or one room's) books.
NON_TOPIC_WORDS = {
    "list", "lists", "listing", "enumerate", "all", "every", "everything",
    "how", "many", "what", "which", "are", "is", "the", "a", "an", "of",
    "in", "on", "at", "from", "for", "to", "and", "or", "me", "us", "you",
    "your", "our", "can", "could", "would", "please", "show", "give", "tell",
    "display", "provide", "do", "does", "have", "has", "there", "available",
    "currently", "now", "library", "libraries", "unklab", "book", "books",
    "article", "articles", "paper", "papers", "research", "researches",
    "room", "rooms", "white", "science", "reference", "title", "titles",
    "author", "authors", "name", "names", "with", "their", "them", "that",
    "this", "these", "those", "full", "complete", "entire", "whole",
    "you", "have", "got", "kind", "kinds", "type", "types", "stored",
    "recorded", "inside", "located", "both", "including", "borrowed",
    "borrow", "borrowable", "status", "statuses", "i", "want", "see", "know",
    "about", "by", "there's", "theres", "s"
}

MAX_LIST_DESCRIPTION = 220


def is_list_question(question):
    return bool(LIST_PATTERN.search(question))


def requested_room(question):
    lowered = question.lower()
    for keyword, room in ROOM_KEYWORDS.items():
        if re.search(rf"\b{keyword}\b", lowered):
            return room
    return None


def topic_words(question):
    words = re.findall(r"[a-zA-Z0-9']+", question.lower())
    return [word for word in words if word not in NON_TOPIC_WORDS]


def in_room(book, room):
    return room is None or room in book["status"].lower()


def format_book_line(number, book, borrowed=False):
    line = f"{number}. {book['title']} — {book['author']} ({book['status']})"
    if borrowed:
        line += " — currently borrowed"
    return line


def answer_full_list(question, room):
    """Build the complete list straight from MySQL (no model needed)."""

    available = [b for b in load_library_books() if in_room(b, room)]
    borrowed = [b for b in load_borrowed_books() if in_room(b, room)]

    where = f"the {room} room" if room else "the library"

    if not available and not borrowed:
        return f"There are no books recorded in {where} right now."

    rows = [(book, False) for book in available] + [(book, True) for book in borrowed]
    rows.sort(key=lambda item: (item[0]["title"].casefold(), item[0]["author"].casefold()))

    lines = [
        format_book_line(index, book, is_borrowed)
        for index, (book, is_borrowed) in enumerate(rows, start=1)
    ]

    summary = f"There are {len(rows)} books in {where}"
    if borrowed:
        summary += f" ({len(available)} available, {len(borrowed)} currently borrowed)"
    summary += ":"

    notes = []
    if room == "reference":
        notes.append("Reference room books and research articles cannot be borrowed.")
    elif room == "white":
        notes.append("White room books can be borrowed for 3 days.")
    elif room == "science":
        notes.append("Science room books can be borrowed for 1 week.")

    return "\n".join([summary, ""] + lines + ([""] + notes if notes else []))


def books_for_topic_list(room):
    """Every book (optionally one room), with shortened descriptions."""

    books = [b for b in load_library_books() if in_room(b, room)]

    parts = []
    for book in books:
        description = " ".join(book["bookDescription"].split())
        if len(description) > MAX_LIST_DESCRIPTION:
            description = description[:MAX_LIST_DESCRIPTION].rstrip() + "..."
        parts.append(
            f"Title: {book['title']}\n"
            f"Author: {book['author']}\n"
            f"Status: {book['status']}\n"
            f"Description: {description}"
        )

    return "\n\n".join(parts), len(books)


# ============================================================
# AI PROMPT
# ============================================================

template = """
You are an AI assistant for UNKLAB Library.

Your job is to answer questions about books and research
articles currently recorded in the library database.

IMPORTANT RULES:

1. Use only the information in the provided library data.

2. Treat the provided library data as the current source
   of truth for available books and research articles.

3. If the user asks whether a particular book or research
   article is in the library, check the provided data.

4. If a book or research article is not present in the
   provided data, clearly say that it is not found in the
   current library data.

5. Never claim that a book exists in the library based
   only on your general knowledge.

6. Use the recorded status when answering questions about
   where a book or research article is located.

7. Do not invent book titles, authors, statuses, or
   descriptions.

8. If the provided information is insufficient to answer
   the user's question, explain that the information is
   not available in the library data.

9. Answer clearly and naturally.

10. Science room books can only be borrowed for 1 week, white room books can only be borrowed for 3 days and reference room books or research articles cannot be borrowed

11. When the user asks you to list books, list EVERY book in the
    provided data that matches the request, one per line, numbered,
    as "Title — Author (Status)". Never stop after 5 or 10 books and
    never shorten the list with "and more" or "etc.".

Current library information:

{books}

User question:

{question}

Answer:
"""


prompt = ChatPromptTemplate.from_template(template)

chain = prompt | model


# ============================================================
# PROCESS REQUESTS FROM SERVER.JS
# ============================================================

while True:

    line = sys.stdin.readline()

    if not line:
        break

    try:

        # ----------------------------------------------------
        # 1. READ THE REQUEST
        # ----------------------------------------------------

        request = json.loads(line)

        question = request.get("question")

        if not isinstance(question, str) or not question.strip():
            print(
                json.dumps({
                    "error": "A valid question is required."
                }),
                flush=True
            )
            continue

        question = question.strip()

        # ----------------------------------------------------
        # 2. SYNCHRONIZE CHROMA WITH THE MYSQL referenceBookData TABLE
        # ----------------------------------------------------

        # This detects additions, removals, and modifications
        # before the chatbot retrieves any books.

        sync_library_books()

        # ----------------------------------------------------
        # 3. LIST QUESTIONS
        # ----------------------------------------------------

        books = None

        if is_list_question(question):
            room = requested_room(question)

            if not topic_words(question):
                # "list all books", "list the white room books", ...
                print(
                    json.dumps({
                        "answer": answer_full_list(question, room)
                    }),
                    flush=True
                )
                continue

            # "list books about space": give the model every book.
            books, book_count = books_for_topic_list(room)
            if book_count:
                books = (
                    f"(This is the complete list of {book_count} books"
                    + (f" in the {room} room" if room else "")
                    + ". List every one that matches the question.)\n\n"
                    + books
                )

        # ----------------------------------------------------
        # 4. OTHER QUESTIONS: RETRIEVE THE MOST RELEVANT BOOKS
        # ----------------------------------------------------

        if books is None:
            documents = retriever.invoke(question)

            books = "\n\n".join(
                document.page_content
                for document in documents
            )

        if not books.strip():
            books = (
                "No relevant books or research articles "
                "were retrieved from the current library data."
            )

        # ----------------------------------------------------
        # 5. ASK LLAMA
        # ----------------------------------------------------

        result = chain.invoke({
            "books": books,
            "question": question
        })

        # ----------------------------------------------------
        # 6. SEND THE RESPONSE BACK TO SERVER.JS
        # ----------------------------------------------------

        print(
            json.dumps({
                "answer": str(result)
            }),
            flush=True
        )

    except Exception as error:

        # Send errors through stdout as JSON because server.js
        # expects a JSON response for each request.
        print(
            json.dumps({
                "error": str(error)
            }),
            flush=True
        )
