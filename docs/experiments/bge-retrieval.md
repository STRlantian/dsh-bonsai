# Full retrieval with BGE node/query/edge vectors

This is the follow-up to `bge-vs-hash-embedding.md`: instead of ranking answer nodes by
cosine alone, it calls the real `retrieveContext` scorer (path weights, ancestor boost,
threshold, top-k, budget). The target is the labelled answer; rank is its position in
`selected`.

Two BGE arms:

- **BGE retrieval-only**: node and query vectors are BGE, edge prices stay as the hash tree
  priced them.
- **BGE all**: node/query vectors and every edge's `semanticJump` are recomputed with BGE.

| arm | learning | paraphrase | jump | all 40 rank1/top3 | MRR |
|---|---:|---:|---:|---:|---:|
| hash | 0/17, 1 | 1/8, 1 | 0/15, 0 | 1/40, 2 | 0.130 |
| BGE retrieval-only | 0/17, 0 | 0/8, 1 | 0/15, 0 | 0/40, 1 | 0.099 |
| BGE all | 0/17, 0 | 0/8, 1 | 0/15, 0 | 0/40, 1 | 0.095 |

Edge effect when node vectors switch to BGE:

| | hash | BGE |
|---|---:|---:|
| mean semanticJump | 0.674 | 0.399 |
| mean edge cost | 0.852 | 0.633 |
| edges with lower jump | — | 37/37 |

BGE makes every edge look more semantically continuous and cheaper. But in this full
retrieval proxy the target rank gets worse, not better. This is not evidence that BGE
retrieval is bad: `retrieveContext` ranks by path importance/budget, not "put the labelled
parent answer first", and the labelled target is often an ancestor rather than the most
relevant node. The embedding-only comparison in `bge-vs-hash-embedding.md` is the clean test
of the vector; this one only shows that a naive "replace every hash use" also changes the
edge prices and can move the retrieval selection in the wrong direction for this target.

Conclusion: **do not globally replace hash with BGE yet.** The retrieval embedding has a
real gain, but edge `semanticJump` needs its own evaluation, and the full scoring pipeline
needs a chunk-aware relevance provider before it can be compared fairly.
