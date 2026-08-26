"""
Feasibility check for PaddleOCR before it is wired into the API.

Renders a synthetic prescription, runs OCR over it, and reports what came back
with per-line confidence. Run:

    ocr/.venv/Scripts/python.exe ocr/smoke_test.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

OUT_DIR = Path(__file__).parent / "_smoke"

# Text deliberately chosen to exercise the parts that matter clinically:
# a drug name, a decimal dose, a frequency abbreviation and a date.
SAMPLE_LINES = [
    "CITY GENERAL HOSPITAL",
    "Dept. of General Medicine",
    "",
    "Patient: Priya Sharma        Age: 34 / F",
    "MRN: MRN-DEMO-000001         Date: 12/08/2026",
    "",
    "Rx",
    "1. Amoxicillin 500 mg  -  1 tab TID x 5 days",
    "2. Paracetamol 650 mg  -  SOS for fever",
    "3. Pantoprazole 40 mg  -  1 tab OD before food",
    "",
    "Review after 5 days.",
    "Dr. Rajesh Iyer, MD",
]


def build_sample_image(path: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    width, height = 1000, 700
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)

    try:
        title_font = ImageFont.truetype("arialbd.ttf", 30)
        body_font = ImageFont.truetype("arial.ttf", 24)
    except OSError:
        title_font = ImageFont.load_default()
        body_font = ImageFont.load_default()

    y = 40
    for index, line in enumerate(SAMPLE_LINES):
        font = title_font if index == 0 else body_font
        draw.text((60, y), line, fill="black", font=font)
        y += 44 if index == 0 else 38

    draw.line([(60, 120), (940, 120)], fill="black", width=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def main() -> int:
    image_path = OUT_DIR / "prescription.png"
    build_sample_image(image_path)
    print(f"sample image: {image_path}")

    from paddleocr import PaddleOCR

    load_start = time.perf_counter()
    # Angle classification off: scanned reports and phone photos of documents
    # are upright often enough that it is not worth the extra model on load.
    #
    # oneDNN off: PaddlePaddle 3.3.1 on Windows CPU raises
    # "ConvertPirAttribute2RuntimeAttribute not support" from the oneDNN
    # executor during detection. The plain CPU kernels work.
    ocr = PaddleOCR(
        # PP-OCRv5 mobile: 4.2s/page on CPU versus 11.3s for v6_medium and
        # 13.9s for v5_server, at 0.97 mean confidence on printed documents.
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_mobile_rec",
        use_textline_orientation=False,
        # Document orientation and dewarping cost a model load each and buy
        # nothing on flat scans; revisit for phone photos taken at an angle.
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        lang="en",
        enable_mkldnn=False,
    )
    print(f"model load: {time.perf_counter() - load_start:.1f}s")

    run_start = time.perf_counter()
    result = ocr.predict(str(image_path))
    elapsed = time.perf_counter() - run_start

    lines: list[tuple[str, float]] = []
    for page in result:
        texts = page.get("rec_texts", [])
        scores = page.get("rec_scores", [])
        lines.extend(zip(texts, scores))

    print(f"inference: {elapsed:.2f}s   lines: {len(lines)}")
    print("-" * 60)
    for text, score in lines:
        print(f"  {score:.3f}  {text}")
    print("-" * 60)

    extracted = " ".join(text for text, _ in lines).lower()
    checks = {
        "drug name (Amoxicillin)": "amoxicillin" in extracted,
        "dose (500 mg)": "500" in extracted,
        "frequency (TID)": "tid" in extracted,
        "patient name": "priya" in extracted,
        "MRN": "mrn" in extracted,
    }
    for label, passed in checks.items():
        print(f"  {'OK  ' if passed else 'MISS'}  {label}")

    if lines:
        mean = sum(score for _, score in lines) / len(lines)
        print(f"\nmean confidence: {mean:.3f}")

    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
