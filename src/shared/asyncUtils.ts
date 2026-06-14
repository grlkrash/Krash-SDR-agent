export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const rateLimit = async <T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  const queue = items.slice();
  const workerCount = Math.max(1, Math.trunc(concurrency));
  const workers: Promise<void>[] = [];

  for (let i = 0; i < workerCount; i += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) return;
          await fn(item);
        }
      })(),
    );
  }

  await Promise.all(workers);
};
