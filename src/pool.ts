/**
 * Runs `fn` over `items` with a global concurrency limit and a per-group limit
 * (e.g. at most 3 requests at a time to one remote provider). Stops scheduling when `cancelled()` is true.
 */
export async function runPool<T>(
  items: T[],
  opts: { limit: number; groupOf: (item: T) => string; groupLimit: (group: string) => number; cancelled?: () => boolean },
  fn: (item: T) => Promise<void>
): Promise<void> {
  const pending = [...items];
  const active = new Map<string, number>();
  let running = 0;
  let wake: (() => void) | undefined;
  const signal = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (opts.cancelled?.()) pending.length = 0;
      while (running < opts.limit && pending.length) {
        const idx = pending.findIndex((item) => (active.get(opts.groupOf(item)) || 0) < opts.groupLimit(opts.groupOf(item)));
        if (idx < 0) break; // every remaining item's group is saturated — wait for a slot
        const [item] = pending.splice(idx, 1);
        const group = opts.groupOf(item);
        active.set(group, (active.get(group) || 0) + 1);
        running++;
        fn(item)
          .then(
            () => undefined,
            (err) => reject(err)
          )
          .finally(() => {
            running--;
            active.set(group, (active.get(group) || 1) - 1);
            signal();
          });
      }
      if (!running && !pending.length) resolve();
      else wake = pump;
    };
    pump();
  });
}
