# Intent and registry measurements

Measured against the configured MongoDB on 2026-10-08. No purchases or settlements were executed.

## Causes

The previously reported 32-second registry load was not a measurement of query execution alone. `mongoDatabase.get()` included connection and sequential initialization of approximately 25 indexes. A baseline run measured 5,057 ms connection and 19,741 ms index initialization; another measured 4,908 ms and 15,204 ms. Registry retrieval then exceeded a diagnostic 15-second deadline during socket reads.

Parallel index initialization retains every existing index and still waits for all checks before making the database available. Subsequent measurements were 8,339 ms and 5,930 ms. Connection times varied from 3,534 to 7,702 ms. These are network-dependent samples, not controlled throughput guarantees.

The final cold/warm read used a fresh client, then reused its connection. “Cold” does not flush MongoDB's server cache.

| Measurement | Cold | Warm |
| --- | ---: | ---: |
| Full registry client query/transfer/BSON decode | 18,313 ms | 12,915 ms |
| Separate full-read explain server execution | 3 ms | 2 ms |
| Schema/public-key validation | 133 ms | 111 ms |
| Exact mint explain execution | 0 ms | 0 ms |
| Exact mint documents/keys examined | 1 / 1 | 1 / 1 |
| Generic NFT classifier total | 1.13 ms | 0.45 ms |
| Generic NFT registry rows read | 0 | 0 |

The registry contained 7,596 records, approximately 2,871,365 JSON bytes. Mongo command timing for the full find was 18,156/12,758 ms. Explain uses a separate operation and does not transfer the result set, so subtracting it is only an estimate of non-execution overhead. Most elapsed read time is outside server execution (network/result transfer/driver processing), not an unindexed server scan. These measurements cannot distinguish network congestion, bandwidth, geography, TLS, or scheduling without packet/server telemetry. JSON size is not compressed wire size.

## Changes and boundaries

- A strict, anchored generic NFT grammar (for example `Buy any nft under 1 SOL`) classifies before Mongo access. Names, symbols, addresses and mixed requests never use this bypass.
- Bare mint-only classification uses `{ mint }` and the existing unique mint index, with no cached approval. Mixed mint/symbol requests retain the full resolver and substitution protection.
- Ambiguous/named/category resolution retains the short-lived classification cache and complete registry. Purchase, settlement and approval checks remain unchanged and reload current approvals.
- Removed redundant full-array schema parsing; the registry constructor still validates every row and rejects duplicate mints.
- Full reads batch up to 10,000 rows, retain the 50,000-record safety limit, and have 5-second server execution/30-second client operation limits. Exact reads use 3/10 seconds. Mongo connection and socket deadlines are explicit.
- Structured `MongoLatency`, `RegistryLatency`, and `IntentLatency` logs report timings/counts without credentials, prompts or asset holdings.

This does not promise sub-millisecond authenticated HTTP calls: Firebase middleware and other account reads still run. Unrecognized NFT descriptions deliberately retain full resolution rather than risk misclassifying an approved RWA name.

Reproduce with `node --env-file=.env --import tsx scripts/benchmark-registry.mts` from `backend`. The benchmark uses a longer diagnostic-only timeout and runs existing index initialization before read-only measurements. Relevant classification, registry identity and settlement regression suite: 32 tests passed. Backend and test TypeScript checks passed.
