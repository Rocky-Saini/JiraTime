# Automation build plan (working notes, do not commit)

User asked: implement everything from the last proposal, browser scheduler (option A), NO commit.

## Pieces
1. lib/jira-proxy.js: allow PUT /rest/api/2/issue/{id}/worklog/{wid} (edit worklog).
2. public/app.js (core)
   - JT event bus (ready / data / view / templates / schedule), afterScripts(), pool(n) helper
   - caches (localStorage, per account): month worklogs (stale-while-revalidate) + issue index
     (pinned, recent, my open issues, worklog issues, search results); picker cache 5 min
   - loadMonth: 5 parallel worklog calls, save cache, feed index, emit "data"
   - monthView() for display only (cache fallback); monthData() stays fresh-only for duplicate checks
   - attachIssueSearch: instant local results, background Jira merge, arrow keys + Enter
   - calendar: drag to select range, ⋯ button per day -> day drawer
   - preview: Start column, same-day entries stacked (assignStarts); runSubmission uses j.startAt
   - fillMonth: rows, else weekday day plans
   - after submit/undo: reload only affected months
   - remove old templates/plans code (moved to templates.js); logout clears caches
   - mobile menu (☰ + shade)
3. public/templates.js: work templates (issue+hours+comment+aliases), day plans (items, weekdays),
   15 starter templates, migration of old templates/plans, Templates page, export/import JSON,
   calendar selects (From template / Day plan / Save row as template / Save as day plan). API: window.JTT
4. public/day.js: day drawer (view/edit/delete/fill with plan), Today card, Quick log parser
5. public/scheduler.js: daily auto-log (countdown 60s, catch-up ask, skip holiday/partial/complete,
   Web Locks, run log), evening reminder (Notification), Automation page. API: window.JTS
6. public/wizard.js: setup wizard (connect, issues with suggestions, day plan, auto-log), news banner
7. index.html + app.css: new pages, today card, quick log, menu, styles, mobile
8. Tests in /tmp with fake Jira (headless Chrome), screenshots desktop + mobile

## Status
- [x] 1 proxy
- [x] 2 app.js (backup: /tmp/app.js.bak)
- [x] 3 templates.js (needs html ids: tplList planList2 tplInfo tplNew planNew tplStarters tplExport tplImport tplFile)
- [x] 4 day.js (html ids: todayCard qlInput qlGo qlHint)
- [x] 5 scheduler.js (view id: automation; ids sch*)
- [x] 6 wizard.js (ids: newsBanner setWizard tplWizard)
- [x] 7 html/css (backups in /tmp)
- [x] 8 tests (all scenarios PASS, regression PASS)

## Test log
- harness: /tmp/jtt (stub.js fake Jira, run.sh <hash>, public/pre.js + test.js injected)
- smoke: PASS (no JS errors, 15 starters, 30 day cells with ⋯, today card, all views render, open-issues refresh)
- tpl/migrate/import: PASS; search instant+cache+dedupe, month cache, 5 parallel: PASS
- day drawer edit/delete, quick log 10 cases, stacked starts, drag select: PASS
- scheduler countdown/no-double/missed/holiday/reminder/today card: PASS
- wizard (suggestions, fit 8h, plan Mon-Fri, schedule on): PASS
- screenshots desktop/templates/automation/day/mobile/menu/search reviewed; mobile day button + stats fixed
- 502 fix: slow DNS (~8s) + Node fetch per-request lookup -> connect timeouts; proxy now uses DNS cache + keep-alive agent; app retries reads, shows load errors; old server PID 1960975 stopped
