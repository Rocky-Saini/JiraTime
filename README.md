# JiraTime – bulk Jira worklogs + NewersWorld sync
Run: `node server.js` then open http://localhost:3000
First time: enter Jira URL, email and an API token (id.atlassian.com -> Security -> API tokens). Saved only in local `.env`.

## NewersWorld sync (no extension)
1. Open the app -> "NewersWorld Timesheet" (sidebar bottom) -> "Open NewersWorld" (opens your logged-in timesheet tab).
2. In that tab click the bookmark "JiraTime Agent" (drag the ⭐ link from the page to your bookmarks bar once).
   Alternative: "Copy script" and paste it into that tab's DevTools console.
3. Back in the app: Read & compare -> Sync till today.
The agent runs inside your NewersWorld tab and talks to the app only through postMessage; no cookie/token is copied.
Leave dates from NewersWorld are marked in the Jira calendar.
# JiraTime
