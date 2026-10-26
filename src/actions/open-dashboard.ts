import streamDeck, { action, KeyUpEvent, SingletonAction } from "@elgato/streamdeck";

import { DASHBOARD_URL } from "../lib/server";

/** Opens the local dashboard page in the default browser. Its property inspector edits the dashboard's bookmarks. */
@action({ UUID: "com.chektek.chek-tools.open-dashboard" })
export class OpenDashboard extends SingletonAction {
	override async onKeyUp(ev: KeyUpEvent): Promise<void> {
		await streamDeck.system.openUrl(DASHBOARD_URL);
		await ev.action.showOk();
	}
}
