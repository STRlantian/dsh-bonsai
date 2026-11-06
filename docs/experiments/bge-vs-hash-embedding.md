# BGE vs hashed embedding

Same answer nodes from session `2ba794ae`, same questions and labels. Only the answer/question
representation changes; ranking is cosine over all answer nodes. `bge-chunk-*` splits each
answer into 300-character chunks and scores the node from its chunk cosines: `best`, `meanTop3`,
or `meanAll`; `meanvec` is the old single averaged vector, kept for comparison. This is an
embedding-only comparison, not the full retrieval score with path weights.

| method | set | N | rank1 | top3 | MRR |
|---|---|---:|---:|---:|---:|
| hash | learning | 17 | 0 | 3 | 0.186 |
| hash | paraphrase | 8 | 1 | 4 | 0.355 |
| hash | jump | 15 | 3 | 7 | 0.378 |
| hash | all | 40 | 4 | 14 | 0.292 |
| bge | learning | 17 | 1 | 4 | 0.218 |
| bge | paraphrase | 8 | 5 | 5 | 0.692 |
| bge | jump | 15 | 10 | 11 | 0.717 |
| bge | all | 40 | 16 | 20 | 0.500 |
| bge-chunk-meanvec | learning | 17 | 1 | 3 | 0.218 |
| bge-chunk-meanvec | paraphrase | 8 | 3 | 5 | 0.565 |
| bge-chunk-meanvec | jump | 15 | 11 | 12 | 0.786 |
| bge-chunk-meanvec | all | 40 | 15 | 20 | 0.500 |
| bge-chunk-best | learning | 17 | 2 | 6 | 0.275 |
| bge-chunk-best | paraphrase | 8 | 3 | 5 | 0.501 |
| bge-chunk-best | jump | 15 | 7 | 11 | 0.582 |
| bge-chunk-best | all | 40 | 12 | 22 | 0.435 |
| bge-chunk-meanTop3 | learning | 17 | 1 | 5 | 0.236 |
| bge-chunk-meanTop3 | paraphrase | 8 | 3 | 4 | 0.522 |
| bge-chunk-meanTop3 | jump | 15 | 5 | 8 | 0.478 |
| bge-chunk-meanTop3 | all | 40 | 9 | 17 | 0.384 |
| **bge-chunk-meanAll** | learning | 17 | 1 | 3 | 0.219 |
| **bge-chunk-meanAll** | paraphrase | 8 | 5 | 7 | 0.760 |
| **bge-chunk-meanAll** | jump | 15 | **11** | 12 | **0.791** |
| **bge-chunk-meanAll** | all | 40 | **17** | **22** | **0.541** |

Paired against hash on the same 40 questions:

- BGE whole: better **21**, worse **9**, same **9**.
- BGE chunk meanAll: better **24**, worse **10**, same **5**.
- Chunk meanAll vs whole: better **12**, worse **11**, same **16**.

BGE chunk `meanAll` is the best aggregate result: it beats hash on rank1 (17/40 vs 4/40),
top3 (22/40 vs 14/40), and MRR (0.541 vs 0.292). `best` gets more top3 hits (22) but fewer
rank1 (12); `meanTop3` is worse than both. The old mean-vector collapse loses the benefit of
per-chunk comparison.

## What this does and does not mean

- This measures **retrieval ranking**, not parent attachment. The shipping attachment score
  (`attachmentScore`) is lexical/IDF-based and does not use the embedding at all, so replacing
  the hash embedding does not change where questions hang.
- BGE alone is **not** a replacement for the attachment rules: on the 17 non-root learning
  labels its rank1 is 1/17, while the existing lexical + new-topic path is 14/18 on the broader
  attachment label set. It should be a retrieval improvement, not a wholesale replacement.
- The model truncates at 512 tokens; 1,500-char slices lose long-answer tails. Per-chunk scoring
  recovers some of that (`meanAll`), while a single mean vector does not.
- Runtime integration needs chunk vectors per node, not one vector, and an async model. That is a
  larger change than swapping `embedText`; keep the hash default until an optional provider is
  designed.
