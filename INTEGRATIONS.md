# Integrations

Boop uses Composio for Gmail, Google Calendar, and approved additional services. The built-in Patchright browser is separate from Composio.

## Connect an account

Ask Boop to connect a toolkit and name the requested scopes. Boop shows the toolkit and scope summary, then issues a one-hour confirmation code. After confirmation it creates the Composio connection and returns the hosted OAuth URL over iMessage. The owner completes OAuth directly; Boop does not ask for credentials in chat.

New accounts and expanded scopes always repeat this flow. Service API keys, owner identity, and host credentials remain maintenance-only.

## Read and write policy

Retrieval operations such as list, search, fetch, get, and query may run without confirmation. Tool names containing any write verb fail closed even if they also contain a read verb.

Sending or replying to email, changing Calendar, submitting a form, making a purchase, disconnecting an account, and every other external write calls `propose_external_action`. The owner sees the exact destination, account, content, item, quantity, price, URL, arguments, and provenance before receiving a code.

## Gmail notifications and automations

The owner can create an automation over iMessage, for example: “Every five minutes, check Gmail for important unread messages and notify me.” Automation prompts are owner instructions, but retrieved email remains untrusted content. A notification to the owner needs no confirmation; replying, forwarding, archiving, or changing the message still does.

## Browser

Read-only browser tools can open approved public URLs, take accessibility snapshots, extract text, report the URL, and capture a screenshot. Click, fill, keypress, and login handoff are external actions and require confirmation.

The browser profile persists at `/var/lib/boop/browser-profile` and is excluded from backups. Login/MFA handoff uses the same profile through a 30-minute Tailscale-only VNC display. It is never routed through Cloudflare.

## Adding a toolkit

Composio connections are discovered dynamically. The curated names in `server/composio.ts` improve display labels but do not grant authority. No toolkit write becomes autonomous merely because it is connected.
