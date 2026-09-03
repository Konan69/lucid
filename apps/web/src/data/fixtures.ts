import type { ConversationStatus } from "../ui/StatusLabel";
export type Conversation = {
  id: string;
  title: string;
  preview: string;
  status: ConversationStatus;
  unread?: boolean;
  pinned?: boolean;
  usingScreen?: boolean;
  startedAt?: number;      // ms; ticking duration when working
  tools?: string[];        // what Vivid is using: "maps" | "calendar" | "gmail" | "drive"
  when: "today" | "yesterday" | "week" | "earlier";
  time: string;
  snoozeUntil?: string;
};

const now = Date.now();
export const conversations: Conversation[] = [
  { id: "t1", title: "Kash Plus PRD review", preview: "Which payments partner should I shortlist?", status: "attention", unread: true, tools: ["maps", "calendar"], when: "today", time: "2m" },
  { id: "t4", title: "Publish the Interlink spec", preview: "Ready to share with the team. Send it?", status: "approve", tools: ["gmail", "drive"], when: "today", time: "12m" },
  { id: "t2", title: "Draft the ARKchain workstream plan", preview: "Splitting the five workstreams into owners and gates", status: "working", usingScreen: true, startedAt: now - 135_000, tools: ["browser", "calendar"], when: "today", time: "now" },
  { id: "t5", title: "RWA market one-pager", preview: "Comparing the three tokenisation platforms", status: "ready", pinned: true, tools: ["notes"], when: "yesterday", time: "Yesterday" },
  { id: "t3", title: "Pull the grand sheet into projects", preview: "Six PRDs filed under Scale Ventures", status: "done", unread: true, tools: ["drive"], when: "today", time: "9:12" },
  { id: "t7", title: "Summarise today's emails", preview: "Five need a reply; the rest can wait", status: "ready", tools: ["gmail"], when: "today", time: "8:40" },
  { id: "t9", title: "KASH fee quoting edge cases", preview: "Three cases where the quote could drift", status: "ready", tools: ["calendar"], when: "today", time: "8:02" },
  { id: "t6", title: "Sync the grand sheet", preview: "The Drive link expired. Reconnect Drive?", status: "failed", tools: ["browser"], when: "week", time: "Mon" },
  { id: "t10", title: "Arkademy course pricing", preview: "Basic, standard, and 1-on-1 tiers drafted", status: "ready", tools: ["browser"], when: "week", time: "Mon" },
  { id: "t8", title: "Worldstreet API dependency map", preview: "Diagram saved to your files", status: "ready", tools: ["drive"], when: "earlier", time: "Aug 22" },
  { id: "t11", title: "Arkademy launch checklist", preview: "Waiting until Friday", status: "ready", when: "earlier", time: "Aug 20", snoozeUntil: "Fri" },
  { id: "t12", title: "Analyse the RWA platform scan", preview: "Ondo cheapest at 10bps; custody is the tradeoff", status: "ready", tools: ["drive"], when: "today", time: "9:30" },
  { id: "t13", title: "Numbers for the ops review", preview: "Quoting accuracy is 97.2% — up from 94.8%", status: "attention", unread: true, tools: ["drive", "notes"], when: "today", time: "8:45" },
  { id: "t14", title: "Weekly Arkademy signups", preview: "Routine ready — runs every Monday 8am", status: "ready", tools: ["drive"], when: "week", time: "Mon" },
];

export const doneCount = 14;

export type Msg =
  | { kind: "user"; id: string; text: string; time: string }
  | { kind: "konan"; id: string; text: string; time: string; bullets?: Array<{ lead: string; rest: string }>; chip?: { label: string; tone: "accent" | "success" | "neutral" } }
  | { kind: "worked"; id: string; summary: string; duration: string; steps: string[]; delta?: string; open?: boolean }
  | { kind: "automation"; id: string; title: string; trigger: string; actions: string[]; time: string }
  | { kind: "connect"; id: string; intro?: string; services: Array<{ id: string; name: string; detail: string }> }
  | { kind: "card"; id: string; title: string; question: string; options: Array<{ label: string; note: string }> };

/** A full thread for every conversation in the sidebar. */
export const threadsByConversation: Record<string, Msg[]> = {
  t1: [
    { kind: "user", id: "t1m1", text: "Read the Kash Plus PRD and tell me what's blocking the MVP. Focus on payments and the Worldstreet dependency.", time: "10:04" },
    { kind: "konan", id: "t1m1b", text: "Drive and Gmail — adding those now.", time: "10:04" },
    { kind: "connect", id: "t1m1c", services: [
      { id: "drive", name: "Google Drive", detail: "Search, read, create, and share files." },
      { id: "gmail", name: "Gmail", detail: "Search, read, draft, and manage email." },
      { id: "calendar", name: "Google Calendar", detail: "Search events and schedule meetings." },
    ] },
    { kind: "konan", id: "t1m1d", text: "All three are in. Reading the PRD now.", time: "10:04" },
    { kind: "worked", id: "t1m2", summary: "Read the PRD end to end", duration: "48s", steps: ["Parsed all 9 sections of the document", "Traced the Worldstreet API dependencies", "Flagged every unowned decision"], delta: "3 blockers" },
    { kind: "konan", id: "t1m3", text: "Three things block the MVP. The payments partner is unchosen, Worldstreet access has no owner, and the cross-border fee table is empty.", bullets: [
      { lead: "Payments partner", rest: "PRD names two options but no decision or criteria" },
      { lead: "Worldstreet API", rest: "Key dependency; no sandbox access yet" },
      { lead: "Cross-border fees", rest: "The flow exists; the fee table is empty" },
    ], chip: { label: "3 blockers found", tone: "success" }, time: "10:05" },
    { kind: "card", id: "t1m4", title: "Payments decision", question: "Which payments direction should I draft first?", options: [
      { label: "Worldstreet first", note: "Unblock the stated dependency; ask for sandbox access today" },
      { label: "Stablecoin rails", note: "KASH-native; skips a partner but needs the engine spec" },
      { label: "Draft both", note: "One comparison page, your call by Friday" },
    ] },
  ],
  t4: [
    { kind: "user", id: "t4m1", text: "The Interlink spec is final. Send it to the engineering team and Legal.", time: "9:52" },
    { kind: "worked", id: "t4m2", summary: "Checked the draft before sending", duration: "31s", steps: ["Confirmed the threat-model section is complete", "Verified both reviewers signed off", "Prepared the email to Engineering and Legal"], delta: "2 recipients" },
    { kind: "konan", id: "t4m3", text: "The spec is ready to go. I'll send it to Marco (Engineering) and Priya (Legal) with a short summary.", time: "9:53" },
    { kind: "card", id: "t4m4", title: "Confirm send", question: "Send the Interlink spec now?", options: [
      { label: "Send to both", note: "Marco and Priya, with the one-paragraph summary" },
      { label: "Send to Marco only", note: "Legal sees it after engineering review" },
      { label: "Hold", note: "Keep it as a draft; I'll ask again tomorrow" },
    ] },
  ],
  t2: [
    { kind: "user", id: "t2m1", text: "Turn the ARKchain plan into a workstream plan with owners and gates.", time: "10:03" },
    { kind: "worked", id: "t2m2", summary: "Structuring the five workstreams", duration: "2m", steps: ["Read the ARKchain objectives section", "Mapped each workstream to a team", "Drafting testnet and production gates"], open: true },
  ],
  t5: [
    { kind: "user", id: "t5m1", text: "Summarise the RWA market scan into a one-pager for Legal.", time: "Yesterday 4:20pm" },
    { kind: "worked", id: "t5m2", summary: "Wrote the one-pager", duration: "1m 10s", steps: ["Compared the three platforms on custody and fees", "Pulled regulatory notes from the scan", "Saved it to Library › Research"], delta: "Saved" },
    { kind: "automation", id: "t5m3", title: "Keep the one-pager current", trigger: "Every Monday, or when the scan changes", actions: ["Re-read the RWA market scan", "Update the comparison table", "Flag anything Legal should re-review"], time: "Yesterday 4:22pm" },
    { kind: "konan", id: "t5m4", text: "I'll refresh it every Monday and whenever the scan changes. You'll only hear from me if something Legal should re-review.", chip: { label: "Routine created", tone: "accent" }, time: "Yesterday 4:22pm" },
  ],
  t3: [
    { kind: "user", id: "t3m1", text: "Pull the Scale Ventures grand sheet in and make a project for each PRD.", time: "9:11" },
    { kind: "worked", id: "t3m2", summary: "Filed six projects", duration: "52s", steps: ["Read all six rows of the grand sheet", "Matched each PRD tab to its section", "Created the projects with briefs and covers"], delta: "6 projects" },
    { kind: "konan", id: "t3m3", text: "Done. Kash Plus, Interlink, RWA market, KASH engine, ARKchain, and Arkade are all in Projects with their PRDs filed under Library.", chip: { label: "6 projects created", tone: "success" }, time: "9:12" },
  ],
  t7: [
    { kind: "user", id: "t7m1", text: "What needs me in email today?", time: "8:40" },
    { kind: "worked", id: "t7m2", summary: "Read this morning's inbox", duration: "26s", steps: ["Checked 23 new messages", "Sorted by who is waiting on you", "Drafted replies for the top three"], delta: "5 need you" },
    { kind: "konan", id: "t7m3", text: "Five need a reply — two from Legal about the vendor contract, one from John on RWA custody, and two routine. The rest can wait.", time: "8:41" },
  ],
  t9: [
    { kind: "user", id: "t9m1", text: "Go through the KASH engine spec and find where a quote could drift from execution.", time: "8:00" },
    { kind: "worked", id: "t9m2", summary: "Traced the quoting flow", duration: "1m 5s", steps: ["Read the MVP behaviours section", "Compared quote inputs to settlement inputs", "Found three drift points"], delta: "3 cases" },
    { kind: "konan", id: "t9m3", text: "Three cases: network fee spikes between quote and execution, platform fee rounding, and stale pool prices after a large deposit. Want me to write them up as test cases?", time: "8:02" },
  ],
  t6: [
    { kind: "user", id: "t6m1", text: "Re-sync the grand sheet — I updated it this morning.", time: "Mon 9:00" },
    { kind: "konan", id: "t6m2", text: "The Drive link expired, so I couldn't reach the sheet. Reconnect Drive and I'll finish the sync right away.", chip: { label: "Needs Drive access", tone: "accent" }, time: "Mon 9:01" },
  ],
  t10: [
    { kind: "user", id: "t10m1", text: "Draft pricing for Arkademy: basic, standard, and 1-on-1.", time: "Mon 2:15pm" },
    { kind: "worked", id: "t10m2", summary: "Drafted three tiers", duration: "58s", steps: ["Read the Arkademy notes on course structure", "Priced each tier against the weekly lesson model", "Added the points-for-courses discount"], delta: "3 tiers" },
    { kind: "konan", id: "t10m3", text: "Drafted. Basic covers self-paced, standard bundles weekly lessons, and 1-on-1 is the executive tier with tutor scheduling. Saved to Library › Brand & marketing.", time: "Mon 2:16pm" },
  ],
  t8: [
    { kind: "user", id: "t8m1", text: "Map everything that depends on the Worldstreet API across the PRDs.", time: "Aug 22 11:30am" },
    { kind: "worked", id: "t8m2", summary: "Built the dependency map", duration: "1m 22s", steps: ["Searched all six PRDs for Worldstreet references", "Grouped them by product area", "Drew the dependency diagram"], delta: "Saved" },
    { kind: "konan", id: "t8m3", text: "Kash Plus depends on it for trading and payments; nothing else touches it directly. The diagram is saved to your files — worth sending to whoever owns the Worldstreet relationship.", time: "Aug 22 11:32am" },
  ],
  t14: [
    { kind: "user", id: "t14m1", text: "Every Monday, pull Arkademy signups and revenue and compare to the week before.", time: "Mon 8:00am" },
    { kind: "worked", id: "t14m2", summary: "Ran the first weekly comparison", duration: "40s", steps: ["Pulled signups and revenue from the course dashboard", "Compared to the prior week", "Wrote the three-line summary"], delta: "Week 1 of the routine" },
    { kind: "konan", id: "t14m3", text: "Monday numbers: 38 new signups (up from 31), £1,240 revenue (down 6%), and the basic tier drove 74% of purchases. Revenue dipped because two 1-on-1 students finished their blocks.", bullets: [
      { lead: "Signups", rest: "38 this week · 31 last · +23%" },
      { lead: "Revenue", rest: "£1,240 · −6% · basic tier is carrying volume" },
      { lead: "To watch", rest: "1-on-1 churn after course blocks end" },
    ], chip: { label: "Routine running", tone: "accent" }, time: "Mon 8:01am" },
    { kind: "automation", id: "t14m4", title: "Weekly Arkademy numbers", trigger: "Every Monday at 8am", actions: ["Pull signups and revenue", "Compare to the prior week", "Post a three-line summary — more only if something drops over 10%"], time: "Mon 8:01am" },
  ],
  t13: [
    { kind: "user", id: "t13m1", text: "I need numbers for tomorrow's ops review. Anything interesting in the last two weeks?", time: "8:44" },
    { kind: "worked", id: "t13m2", summary: "Crunched the last 14 days", duration: "1m 8s", steps: ["Pulled quoting accuracy, float, and support volume", "Compared against the prior fortnight", "Found one trend worth raising"], delta: "1 trend" },
    { kind: "konan", id: "t13m3", text: "Quoting accuracy is up and support volume is flat, but float concentration is creeping: one pool now holds 41% of stablecoin float, up from 28%. Worth deciding before the review whether to rebalance.", bullets: [
      { lead: "Quoting accuracy", rest: "97.2% · up from 94.8% two weeks ago" },
      { lead: "Support volume", rest: "flat · 31 tickets this fortnight" },
      { lead: "Float concentration", rest: "one pool at 41%, was 28% — the trend to raise" },
    ], chip: { label: "1 trend flagged", tone: "accent" }, time: "8:45" },
    { kind: "card", id: "t13m4", title: "Ops review", question: "Should I add the rebalancing question to the agenda?", options: [
      { label: "Yes, add it", note: "One slide: the 41% number and two options" },
      { label: "Not this review", note: "Keep monitoring; flag again if it passes 45%" },
      { label: "Investigate first", note: "Find out why the pool is growing before the review" },
    ] },
  ],
  t12: [
    { kind: "user", id: "t12m1", text: "Analyse the RWA platform scan — which of the three should we shortlist for Legal?", time: "9:28" },
    { kind: "worked", id: "t12m2", summary: "Scored the three platforms", duration: "1m 15s", steps: ["Normalised fees to basis points", "Checked custody model against the Legal playbook", "Weighted the scores: fees 40%, custody 40%, track record 20%"], delta: "3 platforms" },
    { kind: "konan", id: "t12m3", text: "Ondo wins on cost, Securitize on custody fit. Centrifuge is cheapest per deal but its custody model needs a Legal exception.", bullets: [
      { lead: "Ondo", rest: "10bps · qualified custody · strongest track record — 8.1/10" },
      { lead: "Securitize", rest: "25bps · matches the playbook exactly — 7.8/10" },
      { lead: "Centrifuge", rest: "8bps · custody needs a Legal exception — 6.9/10" },
    ], chip: { label: "Shortlist: Ondo + Securitize", tone: "success" }, time: "9:30" },
    { kind: "konan", id: "t12m4", text: "The comparison sheet is saved to Library › Research with the scoring weights shown, so Legal can adjust them and the ranking recomputes.", time: "9:30" },
  ],
  t11: [
    { kind: "user", id: "t11m1", text: "Set up the Arkademy launch checklist and check in on Fridays.", time: "Aug 20 5:00pm" },
    { kind: "automation", id: "t11m2", title: "Arkademy launch watch", trigger: "Every Friday at 9am", actions: ["Check the checklist for unowned items", "Nudge anyone waiting over a week", "Report only what changed"], time: "Aug 20 5:01pm" },
    { kind: "konan", id: "t11m3", text: "Done. I'll check every Friday and only ping you when something moved. Snoozed until then.", chip: { label: "Routine created", tone: "accent" }, time: "Aug 20 5:01pm" },
  ],
};

export const activeConversation = {
  id: "t1",
  title: "Kash Plus PRD review",
  startedAt: "10:04",
  tools: ["drive", "gmail"],
  messages: threadsByConversation.t1,
};

export const queued: Record<string, string> = {
  t1: "Check what the ARKchain spec says about fee abstraction first.",
  t2: "Assign an owner to the indexing workstream when you reply.",
};

export function queuedFor(id: string): string {
  return queued[id] ?? "I'll pick this back up as soon as the current step finishes.";
}

export const suggestions = [
  "What's blocking the Kash Plus MVP?",
  "Turn the ARKchain plan into owners and gates",
  "Catch me up on the RWA market scan",
];
