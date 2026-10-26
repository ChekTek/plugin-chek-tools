import { action, KeyUpEvent, SingletonAction } from "@elgato/streamdeck";

import refreshService from "../services/refresh-service";

/** Refreshes GitHub, GitLab and Jira at once and feeds the results to the dashboard. */
@action({ UUID: "com.chektek.chek-tools.refresh" })
export class Refresh extends SingletonAction {
	override async onKeyUp(ev: KeyUpEvent): Promise<void> {
		const ok = await refreshService.refreshAll();
		if ([...this.actions].some((a) => a.id === ev.action.id)) {
			await (ok ? ev.action.showOk() : ev.action.showAlert());
		}
	}
}
