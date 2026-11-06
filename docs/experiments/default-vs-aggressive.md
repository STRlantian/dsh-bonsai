# Default vs aggressive preset, same tool visibility

Generated from the 60-turn offline simulation in `default-vs-baseline.*` and
`aggressive-vs-baseline.*`.

Both plugin arms use `toolDeny: []` (zero hidden tools) and the same system/tool
overhead of 10,453 tokens, so the only difference is folding. The aggressive
preset's `fileRegion: digest` and `mandatoryContext: true` do not affect this
run because the model never calls `retrieve_context`.

| | baseline | default | aggressive |
|---|---:|---:|---:|
| fold threshold | — | 30,000 | 10,000 |
| keep turns | — | 2 | 1 |
| block ratio | — | 8x | 5x |
| cadence | — | 10 | 3 |
| folds in 60 turns | — | 3 | 11 |
| prompt tokens | 8,485,200 | 3,613,470 | 2,072,930 |
| hit tokens | 8,217,107 | 3,292,307 | 1,711,904 |
| miss tokens | 268,093 | 321,163 | 361,026 |
| cost at 0.02/1 per 1M | 0.4324 | 0.3870 | 0.3953 |
| saving vs baseline | — | **10.5%** | 8.6% |
| final prompt | 268,093 | 69,145 | **37,428** |
| first cumulative break-even | — | turn 41 | turn 41 |

Cumulative cost at fixed horizons:

| turns | baseline | default | aggressive |
|---:|---:|---:|---:|
| 20 | 0.1166 | 0.1327 (+13.8%) | 0.1288 (+10.4%) |
| 40 | 0.2574 | 0.2583 (+0.3%) | 0.2589 (+0.6%) |
| 60 | 0.4324 | 0.3870 (−10.5%) | 0.3953 (−8.6%) |

Default folds affect the prompt at turns 20, 36, 52. Its folds are more
expensive per event than the aggressive preset's (14.9k–17.3k vs 9.6k–13.2k
miss tokens), but it folds three times instead of eleven.

At equal tool visibility the tuned default is both **cheaper** and **keeps one
more turn** than the aggressive preset over 60 turns. Aggressive still wins on
prompt size (37k vs 69k) and, in its shipped form, hides nine heavy tools. If
prompt headroom is the priority, aggressive is the right preset; if cost is the
priority, the tuned default is better at this horizon.

The full per-turn rows are in `aggressive-vs-baseline.csv` and
`default-vs-baseline.csv`.
