# Wedding Trend Curation Scoring System: Golden Set Label Schema & Annotator Guidelines

This document defines the labeling instructions and metadata requirements for human annotators building the Stage 2 evaluation golden set for the wedding-trend curation scoring system.

## Legal Compliance Notice (spec.md §10)

This curation system operates as a neutral curation media outlet. **Annotators and evaluation harnesses must NOT reproduce original creative expression, full text, or substantial copyrighted excerpts of source articles in notes, annotations, or reports.** All justifications must be brief, factual, and non-creative summaries or category classifications.

---

## 1. Evaluation Criteria (5 Criteria)

Each article is evaluated against five 0-9 integer criteria, mirroring the LLM evaluation logic:

1. **`firsthand` (0-9 integer)**
   - The degree to which the article is written from personal, direct wedding planning or execution experience by the writer or close parties.
   - `0`: General commentary, third-party aggregation, or industry PR without personal experience.
   - `9`: Fully grounded in firsthand personal experience.

2. **`ceremonyDecision` (0-9 integer)**
   - The degree to which the article addresses specific decisions regarding wedding ceremony content, venue choice, dress selection, guest handling, or budget allocation.
   - Requires `>= 1` along with `weddingDayContent >= 1` to pass the curation gate.

3. **`specific` (0-9 integer)**
   - The degree of concreteness of actual execution details (concrete choices, numerical data, actual things done or reasons for things not done).

4. **`weddingDayContent` (0-9 integer)**
   - The degree to which the article strictly deals with the actual wedding-day content (ceremony proceedings, production/direction, run-of-show, or what literally happened on the day).
   - `0`: Photo weddings, pre-wedding photo shoots (前撮り), preparation stages, venue searching, or after-stories only (absorbing the obsolete `preDecisionOrPhotoShoot`).

5. **`promotional` (0-9 integer)**
   - The degree of commercial promotion or inducement to proprietary services by business entities.
   - Only penalizes when `>= 7`.

---

## 2. Phase Classification (`phase_label`)

Every corpus entry must be classified into one of four primary phase buckets:

- `"ceremony-content"`: Core planning, day-of execution, guest hospitality, venue coordination.
- `"pre-decision"`: Early stage inspiration, engagement prep, general relationship milestones before active vendor contact.
- `"photo-venue-search"`: Dedicated studio/location photo shoots, initial venue tours, and price comparisons.
- `"unclear"`: Borderline or ambiguous articles that do not fit neatly into the above categories.

---

## 3. Metadata Requirements

Each entry in `corpus.json` requires:

- `id`: Sequential integer ID.
- `article_id`: Original database post ID (if applicable).
- `url`: Canonical URL of the source article.
- `source_name`: Platform identifier (e.g., `"note"`, `"zexy"`, etc.).
- `phase_label`: One of the four phase classifications above.
- `firsthand`: 0-9 integer degree.
- `ceremonyDecision`: 0-9 integer degree.
- `specific`: 0-9 integer degree.
- `weddingDayContent`: 0-9 integer degree.
- `promotional`: 0-9 integer degree.
- `annotator_notes`: Brief, non-creative justification for the labels (strictly complying with spec.md §10).
- `excerpt_length`: Length of the excerpt stored for reference.
- `annotated_by`: Annotator identifier or role (`"orchestrator"` or human identifier).
- `annotated_at`: ISO date string (e.g., `"2026-08-26"`).
