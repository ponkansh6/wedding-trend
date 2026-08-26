# Wedding Trend Curation Scoring System: Golden Set Label Schema & Annotator Guidelines

This document defines the labeling instructions and metadata requirements for human annotators building the Stage 2 evaluation golden set for the wedding-trend curation scoring system.

## Legal Compliance Notice (spec.md §10)

This curation system operates as a neutral curation media outlet. **Annotators and evaluation harnesses must NOT reproduce original creative expression, full text, or substantial copyrighted excerpts of source articles in notes, annotations, or reports.** All justifications must be brief, factual, and non-creative summaries or category classifications.

---

## 1. Evaluation Criteria (6 Criteria)

Each article is evaluated against six binary or ternary criteria, mirroring the LLM evaluation logic:

1. **`firsthand` (Boolean)**
   - `true`: Written from personal, direct wedding planning or execution experience.
   - `false`: General commentary, third-party aggregation, or industry PR without personal experience.

2. **`ceremony` / `ceremonyDecision` (Boolean)**
   - `true`: Directly addresses specific decisions regarding wedding ceremony content, venue choice, dress selection, guest handling, or budget allocation.
   - `false`: Broad general lifestyle content unrelated to wedding decision-making.

3. **`specific` (Boolean)**
   - `true`: Contains concrete numbers, specific vendor/venue naming details, actual costs, or actionable timelines.
   - `false`: Vague impressions or abstract advice without concrete details.

4. **`tradeoff` (Boolean)**
   - `true`: Discusses tangible trade-offs (e.g., cost vs. quality, guest convenience vs. budget, DIY vs. outsourced).
   - `false`: Purely one-sided praise or uncritical recommendations.

5. **`promotional` (Ternary: `"none"` | `"light"` | `"heavy"` )**
   - `"none"`: Completely independent user experience or neutral discussion.
   - `"light"`: Minor vendor mention or subtle affiliate/PR context that does not dominate the core narrative.
   - `"heavy"`: Overt promotional content, direct vendor advertisement, or heavily monetized PR piece.

6. **`preDecisionOrPhotoShoot` (Boolean)**
   - `true`: Focuses primarily on pre-decision dreaming, initial inspiration, or dedicated photo-shoot-only planning without substantive decision content.
   - `false`: Focuses on substantive decision-making or execution.

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
- `firsthand`: Boolean.
- `ceremonyDecision`: Boolean.
- `specific`: Boolean.
- `tradeoff`: Boolean.
- `promotional`: `"none"` | `"light"` | `"heavy"`.
- `preDecisionOrPhotoShoot`: Boolean.
- `annotator_notes`: Brief, non-creative justification for the labels (strictly complying with spec.md §10).
- `excerpt_length`: Length of the excerpt stored for reference.
- `annotated_by`: Annotator identifier or role (`"orchestrator"` or human identifier).
- `annotated_at`: ISO date string (e.g., `"2026-08-26"`).
