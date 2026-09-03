/* Routines: what Konan repeats for you. Some you wrote; some started as
   templates from the gallery — published by Konan or by other teams, sold,
   with a cut of every sale going to the author. */

export type Routine = {
  id: string;
  name: string;
  /** What it does, in one line. */
  summary: string;
  trigger: string;
  actions: string[];
  fromTemplate?: string;
  lastRun: string;
  runs: number;
};

export type RoutineTemplate = {
  id: string;
  name: string;
  summary: string;
  trigger: string;
  actions: string[];
  /** Who published it. "konan" = Konan original. */
  publisher: string;
  brandColor: "accent" | "working" | "approve" | "success";
  price: string;
  /** Sales to date — social proof, Drive-style plainness. */
  installs: string;
  rating: string;
  /** Cut the author keeps on each sale. */
  authorCut?: string;
};

export const routines: Routine[] = [
  {
    id: "r-weekly-arkademy",
    name: "Weekly Arkademy numbers",
    summary: "Signups and revenue every Monday, three-line summary",
    trigger: "Every Monday at 8am",
    actions: ["Pull signups and revenue", "Compare to the prior week", "Post a summary — more only if something drops over 10%"],
    lastRun: "Mon 8:01am",
    runs: 6,
  },
  {
    id: "r-rwa-onepager",
    name: "Keep the RWA one-pager current",
    summary: "Refreshes the Legal one-pager when the market scan changes",
    trigger: "Every Monday, or when the scan changes",
    actions: ["Re-read the RWA market scan", "Update the comparison table", "Flag anything Legal should re-review"],
    lastRun: "Yesterday 4:22pm",
    runs: 11,
  },
  {
    id: "r-launch-watch",
    name: "Arkademy launch watch",
    summary: "Friday check for unowned or stalled launch items",
    trigger: "Every Friday at 9am",
    actions: ["Check the checklist for unowned items", "Nudge anyone waiting over a week", "Report only what changed"],
    lastRun: "Last Fri 9:00am",
    runs: 3,
  },
];

export const templates: RoutineTemplate[] = [
  {
    id: "tpl-weekly-numbers",
    name: "Weekly numbers",
    summary: "One metric, every week, three lines. Signups, revenue, tickets — point it at anything you count.",
    trigger: "Weekly, your pick of day and time",
    actions: ["Pull the metric", "Compare to the prior period", "Post a summary — escalate only past your threshold"],
    publisher: "konan",
    brandColor: "accent",
    price: "Free",
    installs: "41k",
    rating: "4.9",
  },
  {
    id: "tpl-contract-watch",
    name: "Contract renewal watch",
    summary: "Never miss a renewal. Konan reads your contracts and starts the renegotiation conversation 60 days out.",
    trigger: "Daily scan, alerts 60 days before renewal",
    actions: ["Read contract dates from your files", "Alert 60, 30, and 7 days out", "Draft the renewal email for your approval"],
    publisher: "konan",
    brandColor: "accent",
    price: "£3/mo",
    installs: "12k",
    rating: "4.8",
  },
  {
    id: "tpl-tender-triage",
    name: "Tender triage",
    summary: "For ops teams that bid on contracts. Konan reads each tender, scores fit, and drafts the compliance checklist.",
    trigger: "When a new tender lands in the shared folder",
    actions: ["Read the tender end to end", "Score fit against your capability matrix", "Draft the compliance checklist and own the gaps"],
    publisher: "Whitehall Works",
    brandColor: "working",
    price: "£9/mo",
    installs: "1.8k",
    rating: "4.7",
    authorCut: "70%",
  },
  {
    id: "tpl-brand-guard",
    name: "Brand guard",
    summary: "For marketing teams. Every deck or page that mentions the brand gets checked against the guidelines before it ships.",
    trigger: "When a file is added to the brand review folder",
    actions: ["Check logos, colors, and tone against the guidelines", "Leave inline notes on what to fix", "Mark it ready when it passes"],
    publisher: "Studio Norr",
    brandColor: "approve",
    price: "£5/mo",
    installs: "3.4k",
    rating: "4.6",
    authorCut: "70%",
  },
  {
    id: "tpl-intake",
    name: "Client intake to file",
    summary: "For legal and admin. New client form comes in, Konan files it, runs conflicts, and opens the matter folder.",
    trigger: "When an intake form is submitted",
    actions: ["File the intake form", "Run the conflicts check", "Open the matter folder and brief the team"],
    publisher: "Kestrel Legal Ops",
    brandColor: "success",
    price: "£12/mo",
    installs: "940",
    rating: "4.9",
    authorCut: "70%",
  },
  {
    id: "tpl-close-week",
    name: "Close the week",
    summary: "Friday afternoon, Konan closes your week: chases what's stuck, archives what's done, and writes the Monday brief.",
    trigger: "Every Friday at 4pm",
    actions: ["Chase every conversation waiting over 3 days", "Archive settled work", "Write the Monday brief from what moved"],
    publisher: "konan",
    brandColor: "accent",
    price: "Free",
    installs: "28k",
    rating: "4.8",
  },
];
