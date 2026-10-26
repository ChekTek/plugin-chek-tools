import streamDeck from "@elgato/streamdeck";

import store, { type Bookmark } from "../plugin-store";

/**
 * Bookmarks are dashboard-wide and live in the plugin's global settings. This keeps the
 * store in step with them from plugin start, whether or not an Open Dashboard key is visible.
 */
class BookmarksService {
	async start(): Promise<void> {
		streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => this.publish(ev.settings));
		this.publish(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
	}

	private publish(settings: GlobalSettings): void {
		const bookmarks = (settings.bookmarks ?? []).filter((b) => b.name && b.url);
		store.update((s) => {
			s.bookmarks = bookmarks;
		});
	}
}

export default new BookmarksService();

type GlobalSettings = {
	bookmarks?: Bookmark[];
};
