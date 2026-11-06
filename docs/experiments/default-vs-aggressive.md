# Default vs aggressive preset, same tool visibility

Generated from the 60-turn offline simulation in `default-vs-baseline.*` and
`aggressive-vs-baseline.*`.

Both plugin arms use `toolDeny: []` (zero hidden tools) and the same system/tool
overhead of 10,453 tokens, so the only difference is folding. The aggressive
preset's `fileRegion: digest` and `mandatoryContext: true` do not affect this
run because the model never calls `retrieve_context`.

| | baseline | default | aggressive |
|---|---:|---:|---:|
| fold threshold | — | 40,000 | 10,000 |
| keep turns | — | 3 | 1 |
| block ratio | — | 5x | 5x |
| cadence | — | 3 | 3 |
| folds in 60 turns | — | 3 | 11 |
| prompt tokens | 8,485,200 | 3,749,400 | 2,072,930 |
| hit tokens | 8,217,107 | 3,414,860 | 1,711,904 |
| miss tokens | 268,093 | 334,540 | 361,026 |
| cost at 0.02/1 per 1M | 0.4324 | 0.4028 | 0.3953 |
| saving vs baseline | — | 6.8% | **8.6%** |
| final prompt | 268,093 | 82,738 | **37,428** |
| first cumulative break-even | — | turn 45 | **turn 41** |

Cumulative cost at fixed horizons:

| turns | baseline | default | aggressive |
|---:|---:|---:|---:|
| 20 | 0.1166 | 0.1372 (+17.7%) | 0.1288 (+10.4%) |
| 40 | 0.2574 | 0.2681 (+4.2%) | 0.2589 (+0.6%) |
| 60 | 0.4324 | 0.4028 (−6.8%) | 0.3953 (−8.6%) |

Aggressive folds affect the prompt at turns 8, 13, 18, 23, 28, 33, 38, 43, 48,
53, 58. Its folds are cheaper per event (9.6k–13.2k miss tokens, $0.0099–$0.0135)
than the default's (19.5k–21.7k, $0.0198–$0.0220), but it folds 11 times instead
of 3.

The aggressive preset is not free: at 40 turns it is still 0.6% more expensive
than no plugin, and its miss total is 34.7% higher than baseline. It wins at 60
turns because its prompt is 75.6% smaller, so the 0.02 hit price dominates.

The full per-turn rows are in `aggressive-vs-baseline.csv` and
`default-vs-baseline.csv`.
