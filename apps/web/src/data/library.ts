export type ItemKind = "doc" | "sheet" | "image" | "booking" | "receipt" | "list" | "memory";

export type LibraryItem = {
  id: string;
  name: string;
  kind: ItemKind;
  /** Where it came from: the conversation that made it. */
  from: string;
  time: string;
  size?: string;
};

export type LibraryFolder = {
  id: string;
  name: string;
  count: number;
  /** Memory folders read as "what Konan keeps about you". */
  memory?: boolean;
  preview?: string;
};

export const folders: LibraryFolder[] = [
  { id: "f-prds", name: "PRDs", count: 6, preview: "Kash Plus, Interlink, RWA, KASH engine, ARKchain, Arkade" },
  { id: "f-legal", name: "Legal", count: 5, preview: "Vendor contract, custody questions, compliance checklist" },
  { id: "f-research", name: "Research", count: 8, preview: "RWA platform scan, Worldstreet API notes" },
  { id: "f-brand", name: "Brand & marketing", count: 4, preview: "Launch one-pager, Arkademy course blurbs" },
];

export const memoryFolders: LibraryFolder[] = [
  { id: "m-you", name: "About you", count: 8, memory: true, preview: "How you run reviews, what you escalate, how you like things done" },
  { id: "m-people", name: "People", count: 11, memory: true, preview: "Adejoke, John, Marco — who owns what and why" },
  { id: "m-projects", name: "Project memory", count: 6, memory: true, preview: "Decisions made per PRD, and what is still open" },
];

export const recentFiles: LibraryItem[] = [
  { id: "i1", name: "Kash Plus PRD — blockers", kind: "list", from: "Kash Plus PRD review", time: "10:05", size: "3 blockers" },
  { id: "i2", name: "RWA platform comparison", kind: "sheet", from: "RWA market one-pager", time: "9:58", size: "3 platforms" },
  { id: "i3", name: "Interlink spec (ready to share)", kind: "doc", from: "Publish the Interlink spec", time: "Aug 22", size: "9 pages" },
  { id: "i4", name: "Vendor contract (redlined)", kind: "doc", from: "Contract review for Legal", time: "Yesterday", size: "PDF · 240 KB" },
  { id: "i5", name: "ARKchain workstream plan", kind: "list", from: "Draft the ARKchain workstream plan", time: "Yesterday", size: "5 streams" },
  { id: "i6", name: "Grand sheet — synced snapshot", kind: "sheet", from: "Pull the grand sheet into projects", time: "9:12", size: "6 PRDs" },
  { id: "i7", name: "Arkademy pricing tiers", kind: "doc", from: "Arkademy course pricing", time: "Mon", size: "3 tiers" },
  { id: "i8", name: "Launch one-pager", kind: "receipt", from: "Launch checklist", time: "Mon", size: "1 page" },
];

export const memoryFiles: LibraryItem[] = [
  { id: "k1", name: "How you run PRD reviews", kind: "doc" as ItemKind, from: "Learned over 14 conversations", time: "Updated 10:05", size: "Preferences" },
  { id: "k2", name: "People — Adejoke", kind: "doc", from: "Owns Kash Plus product decisions", time: "Updated 8:02", size: "3 notes" },
  { id: "k3", name: "Open decisions by project", kind: "doc", from: "Kept current automatically", time: "Updated today", size: "6 projects" },
  { id: "k4", name: "Your launch checklist", kind: "doc", from: "Verified once", time: "Updated Aug 20", size: "2 notes" },
];
