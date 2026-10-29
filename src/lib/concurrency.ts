/** Runs fn over items with at most `limit` in flight at once. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	const worker = async (): Promise<void> => {
		for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
			await fn(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
