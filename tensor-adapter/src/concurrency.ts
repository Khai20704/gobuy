/**
 * Bounded-concurrency helpers for read-only batch work.
 *
 * Discovery fans out over hundreds of candidate accounts. Unbounded `Promise.all` buries a free RPC
 * plan in 429s and makes a single transport failure race the whole batch, while a fully sequential
 * loop cannot finish inside the caller's deadline. These helpers cap in-flight requests and preserve
 * input order so results stay deterministic.
 */
export async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  run: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!items.length) return []
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length))
  const results = new Array<Output>(items.length)
  let next = 0
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index], index)
    }
  })
  // Fail fast like Promise.all: the first rejection stops the batch and propagates.
  await Promise.all(workers)
  return results
}

/** Splits a list into fixed-size batches; the last batch may be smaller. */
export function chunk<Item>(items: readonly Item[], size: number): Item[][] {
  const width = Math.max(1, Math.floor(size))
  const batches: Item[][] = []
  for (let index = 0; index < items.length; index += width) batches.push(items.slice(index, index + width))
  return batches
}
