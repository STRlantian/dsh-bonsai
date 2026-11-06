# BGE vs hashed embedding

Same answer nodes from session `2ba794ae`, same questions and labels. Only the answer/question
vector changes; ranking is cosine over all answer nodes. `bge-chunk` averages 300-character
chunk vectors into one node vector. This is an embedding-only comparison, not the full retrieval
score with path weights.

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
| bge-chunk | learning | 17 | 1 | 3 | 0.218 |
| bge-chunk | paraphrase | 8 | 3 | 5 | 0.565 |
| bge-chunk | jump | 15 | 11 | 12 | 0.786 |
| bge-chunk | all | 40 | 15 | 20 | 0.500 |

Paired against hash on the same 40 questions, BGE is better on **21**, worse on **9**, and
unchanged on **9**. By set: paraphrase 4 better / 1 worse / 2 same; jump 10 / 1 / 4;
learning 7 / 7 / 3.

BGE whole is the best single-vector replacement here: it beats hash on every aggregate metric.
BGE chunk-mean is better on the jump set (11/15 rank1 vs 10/15) but worse on paraphrase
(3/8 vs 5/8), and has no aggregate gain over whole-answer BGE.

## What this does and does not mean

- This measures **retrieval ranking**, not parent attachment. The shipping attachment score
  (`attachmentScore`) is lexical/IDF-based and does not use the embedding at all, so replacing
  the hash embedding does not change where questions hang.
- BGE alone is **not** a replacement for the attachment rules: on the 17 non-root learning
  labels its rank1 is 1/17, while the existing lexical + new-topic path is 14/18 on the broader
  attachment label set. It should be a retrieval improvement, not a wholesale replacement.
- The model truncates at 512 tokens; 1,500-char slices lose long-answer tails. Chunking helps
  the jump set but not the overall result.

