import streamDeck from "@elgato/streamdeck";

import { OpenDashboard } from "./actions/open-dashboard";
import { Refresh } from "./actions/refresh";
import { startDashboardServer } from "./lib/server";
import bookmarksService from "./services/bookmarks-service";
import refreshService from "./services/refresh-service";

streamDeck.logger.setLevel("info");
streamDeck.settings.useLegacySettingsBehavior = false;

streamDeck.actions.registerAction(new OpenDashboard());
streamDeck.actions.registerAction(new Refresh());

// streamdeck://plugins/message/com.chektek.chek-tools/refresh triggers a refresh from anywhere.
streamDeck.system.onDidReceiveDeepLink((ev) => {
	if (ev.url.path === "/refresh") refreshService.refreshAll();
});

startDashboardServer();
await streamDeck.connect();
await bookmarksService.start();
