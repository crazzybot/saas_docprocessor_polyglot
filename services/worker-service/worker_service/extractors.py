"""Text extraction strategies, dispatched by content type.

Each extractor is synchronous and CPU-bound, so `extract_text` runs it in a
worker thread via `asyncio.to_thread` to avoid blocking the event loop.
"""

from __future__ import annotations

import asyncio
import io
from collections.abc import Callable
from typing import Final

import fitz  # PyMuPDF
import pytesseract
from docx import Document as DocxDocument
from PIL import Image


class UnsupportedContentTypeError(ValueError):
    """Raised when a job references a content type with no registered extractor."""


def _extract_pdf_text(data: bytes) -> str:
    """Extract text from a PDF using PyMuPDF (fitz)."""
    text_parts: list[str] = []
    with fitz.open(stream=data, filetype="pdf") as pdf_doc:
        for page in pdf_doc:
            # PyMuPDF attaches get_text to Page at import time
            # (`Page.get_text = utils.get_text`), so type checkers can't see it.
            text_parts.append(page.get_text())  # pyright: ignore[reportAttributeAccessIssue]
    return "\n".join(text_parts).strip()


def _extract_docx_text(data: bytes) -> str:
    """Extract text from a DOCX file using python-docx."""
    document = DocxDocument(io.BytesIO(data))
    paragraphs = [paragraph.text for paragraph in document.paragraphs]
    return "\n".join(paragraphs).strip()


def _extract_image_text(data: bytes) -> str:
    """Extract text from an image via Tesseract OCR (pytesseract + Pillow)."""
    with Image.open(io.BytesIO(data)) as image:
        # Convert to RGB to normalise palette/greyscale/CMYK images before OCR.
        return pytesseract.image_to_string(image.convert("RGB")).strip()


_EXTRACTORS: Final[dict[str, Callable[[bytes], str]]] = {
    "application/pdf": _extract_pdf_text,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": _extract_docx_text,
    "image/png": _extract_image_text,
    "image/jpeg": _extract_image_text,
}


async def extract_text(content_type: str, data: bytes) -> str:
    """Dispatch to the correct extraction strategy off the event loop thread."""
    extractor = _EXTRACTORS.get(content_type)
    if extractor is None:
        raise UnsupportedContentTypeError(f"No extractor registered for '{content_type}'")
    return await asyncio.to_thread(extractor, data)
