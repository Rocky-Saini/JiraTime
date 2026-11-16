# JiraTime – bulk Jira worklogs, NewersWorld sync, issue fields

Multi-user web app. Every user signs in with **their own** Jira API token, which stays in **their browser**
(sessionStorage by default, localStorage if "remember on this device" is ticked). The server keeps nothing.

## Deploy on Netlify
1. Push this repo to GitHub and import it in Netlify (settings come from `netlify.toml`:
   publish `public/`, function `netlify/functions/jira.js`, redirect `/jira/*` -> function).
2. Open the site, click "Connect Jira", enter site URL, email and an API token
   (id.atlassian.com -> Security -> API tokens).

The Netlify function (`lib/jira-proxy.js`) is a stateless allow-listed proxy: it only forwards a fixed set of Jira
endpoints, only to `https://*.atlassian.net`, and only for requests coming from the site itself.
Tokens are used per request and are not stored or logged.

## Run locally
`node server.js` -> http://localhost:3000 (same code path, no install needed).

## NewersWorld sync (no extension)
Open the "NewersWorld Timesheet" page, click "Open NewersWorld", then click the "JiraTime Agent" bookmark inside that tab.
The agent runs in your logged-in NewersWorld tab and talks to the app via postMessage only.
