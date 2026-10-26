import { run, runJson } from "../lib/exec";
import store, { type JiraTicket } from "../plugin-store";

const BOARD_ID = 218;
const JQL = 'assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC';

/** Lists Jira work items for the signed-in acli user. */
class JiraService {
	async refresh(): Promise<void> {
		store.setJob("jira", { message: "Searching" });
		const site = store.state.jira.site || (await this.site());
		const issues = await runJson<AcliIssue[]>("acli", ["jira", "workitem", "search", "--jql", JQL, "--json", "--limit", "100"]);

		const tickets: JiraTicket[] = issues.map((i) => ({
			key: i.key,
			summary: i.fields.summary,
			status: i.fields.status.name,
			type: i.fields.issuetype.name,
			priority: i.fields.priority?.name ?? "",
			url: `https://${site}/browse/${i.key}`
		}));

		// The board-ID route does not require a project key.
		const boardUrl = `https://${site}/secure/RapidBoard.jspa?rapidView=${BOARD_ID}`;
		store.update((s) => {
			s.jira = { tickets, site, boardUrl };
		});
		store.setJob("jira", { message: `${tickets.length} tickets` });
	}

	/** Reads the Atlassian site host (e.g. example.atlassian.net) from acli's auth status. */
	private async site(): Promise<string> {
		const { stdout } = await run("acli", ["jira", "auth", "status"]);
		// Matches the "Site: host" line acli prints when authenticated.
		const site = /Site:\s*(\S+)/.exec(stdout)?.[1];
		if (!site) throw new Error("acli is not authenticated: run `acli jira auth login`");
		return site;
	}
}

export default new JiraService();

type AcliIssue = {
	key: string;
	fields: {
		summary: string;
		status: { name: string };
		issuetype: { name: string };
		priority: { name: string } | null;
	};
};
