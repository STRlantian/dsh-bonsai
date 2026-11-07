# semanticJump edge labels

Generated from 40 counterfactual edges (17 learning, 8 paraphrase, 15 jump).

Positive edge: question → the answer that introduced the concept. Negative edge: question → the current/last answer (turn 18, or 17 when the target is 18).

| scoring | accuracy | mean positive similarity | mean negative similarity | margin |
|---|---:|---:|---:|---:|
| hash | 62.5% | 0.281 | 0.256 | 0.025 |
| bge-whole | 85.0% | 0.550 | 0.492 | 0.058 |
| bge-chunk-meanAll | 72.5% | 0.532 | 0.502 | 0.030 |

Higher margin is better: the correct parent should be more similar than the current/last answer.

