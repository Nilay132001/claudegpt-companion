# M6 manual checklist (spec §11, §14 M6)

Run on this Mac with the signed bundle (`bash scripts/build-app.sh`, version 0.6.0). Record each result as
PASS / FAIL / NOT RUN with a short note. Use a personal or test Jira site that holds one synthetic issue, never
real work data. No personal data: write the site as `<site>.atlassian.net`, the issue as `<KEY>`, and never paste
the email, the token, issue text or reply text.
Rows marked **Owner** need the owner at the Mac (Atlassian account, Keychain, signed-in chat).

| # | Check | Who | Result |
|---|-------|-----|--------|
| 1 | In the Atlassian account settings, create a **scoped** API token with only `read:jira-work` and `read:jira-user`, for a personal or test site with one synthetic issue | Owner | NOT RUN — needs the owner's Atlassian account |
| 2 | Settings › Jira: enter site, email and token, then Save. The status says "Set up for …" and the token field empties | Owner | NOT RUN — needs the owner at the Mac |
| 3 | Test connection says "Connected. GPT can read Jira." | Owner | NOT RUN — needs the owner at the Mac |
| 4 | Keychain Access shows one item "ClaudeGPT Companion Jira". The app reads it without a prompt on the next launch, or asks once after an ad-hoc rebuild (expected, spec §9) | Owner | NOT RUN — needs the owner at the Mac |
| 5 | Context chip on **Off**: ask "Read issue `<KEY>` and summarise it". The reply cites the key, the chat shows a `companion-jira` tool call, and "View what was sent" holds no token | Owner | NOT RUN — needs the owner at the Mac (signed-in chat) |
| 6 | Ask GPT to "add a comment to `<KEY>`" or "move it to Done". It says it cannot, and nothing changes in Jira (check the issue's history) | Owner | NOT RUN — needs the owner at the Mac (signed-in chat) |
| 7 | Remove: the item is gone from Keychain Access, and the next question cannot use Jira | Owner | NOT RUN — needs the owner at the Mac |
| 8 | A wrong token: Test connection says Jira refused the token | Owner | NOT RUN — needs the owner at the Mac |

Who: Owner = needs the owner at the Mac with their own Atlassian account; Agent = can be checked without a person.
Every row here needs the owner. What an agent could check without a person is in the real-Codex itest
(`companiond/itest/jira.itest.ts`, synthetic server, no login): the thread opens with exactly the three read tools,
`enabled_tools` hides an extra write tool, and the self-check stops the host when it does not.

Known limits (spec §7.1.9 (xii), §11): a site behind a TLS-intercepting proxy with a private root CA shows "Jira
could not be reached" (companion-jira uses Node's bundled CA list). Remove, or saving a new token, ends a running
reply's Jira access at once.
