import { Check, CircleUserRound, Info, Monitor, Settings2, ShieldCheck, X, Plug } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "../ui/Avatar";
import { cn } from "../ui/cn";
import { Connectors } from "./Connectors";

export type ThemePreference = "system" | "light" | "dark";
type Section = "general" | "connectors" | "computer" | "privacy" | "about";

const NAV: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
  { id: "general", label: "General", icon: <Settings2 className="size-4" /> },
  { id: "connectors", label: "Connectors", icon: <Plug className="size-4" /> },
  { id: "computer", label: "Computer", icon: <Monitor className="size-4" /> },
  { id: "privacy", label: "Privacy", icon: <ShieldCheck className="size-4" /> },
  { id: "about", label: "About", icon: <Info className="size-4" /> },
];

export function Settings({ theme, onThemeChange, onClose, initialSection = "general" }: { initialSection?: Section; theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void; onClose: () => void }) {
  const [section, setSection] = useState<Section>(initialSection);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-0 sm:p-6"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section aria-label="Settings" aria-modal="true" role="dialog" className="flex h-full max-h-[720px] w-full max-w-[1040px] overflow-hidden bg-surface-0 shadow-ring-lg animate-fade-in sm:rounded-panel">
        <aside className="hidden w-56 shrink-0 flex-col bg-surface-1 p-3 hairline-r sm:flex">
          <div className="mb-2 flex h-10 items-center px-3 text-title font-title text-ink">Settings</div>
          <SettingsNav section={section} onChange={setSection} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 px-4 sm:px-7">
            <h1 className="min-w-0 flex-1 truncate text-section font-title text-ink">{NAV.find((item) => item.id === section)?.label}</h1>
            <button onClick={onClose} aria-label="Close settings" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><X className="size-4" /></button>
          </header>

          <div className="flex gap-1 overflow-x-auto px-3 pb-2 sm:hidden">
            {NAV.map((item) => (
              <button key={item.id} onClick={() => setSection(item.id)} className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-control px-3 text-label", section === item.id ? "bg-wash-selected text-ink" : "text-ink-3")}>
                {item.icon}{item.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-7">
            {section === "general" && <GeneralSettings theme={theme} onThemeChange={onThemeChange} />}
            {section === "connectors" && <Connectors embedded />}
            {section === "computer" && <ComputerSettings />}
            {section === "privacy" && <PrivacySettings />}
            {section === "about" && <AboutSettings />}
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsNav({ section, onChange }: { section: Section; onChange: (section: Section) => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => (
        <button key={item.id} onClick={() => onChange(item.id)} className={cn("flex h-10 items-center gap-3 rounded-control px-3 text-label transition-colors", section === item.id ? "bg-wash-selected text-ink" : "text-ink-2 hover:bg-wash-hover hover:text-ink")}>
          <span className="text-ink-3">{item.icon}</span>{item.label}
        </button>
      ))}
    </nav>
  );
}

function GeneralSettings({ theme, onThemeChange }: { theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void }) {
  return (
    <div className="mx-auto max-w-3xl space-y-7 pt-3">
      <SettingsGroup label="Account">
        <div className="flex min-h-20 items-center gap-3 px-4 py-3">
          <Avatar name="You" size={42} />
          <span className="min-w-0 flex-1">
            <span className="block text-title font-title text-ink">You</span>
            <span className="block text-label font-meta text-ink-3">Personal workspace</span>
          </span>
          <CircleUserRound className="size-4 text-ink-4" />
        </div>
      </SettingsGroup>

      <SettingsGroup label="Appearance">
        <SettingRow label="Theme">
          <select aria-label="Theme" value={theme} onChange={(event) => onThemeChange(event.target.value as ThemePreference)} className="h-8 rounded-control bg-surface-3 px-3 text-label text-ink ring-line outline-none focus:ring-2 focus:ring-ring">
            <option value="system">Follow system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </SettingRow>
        <SettingRow label="Language"><span className="text-label text-ink-3">Follow system</span></SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Vivid">
        <SettingRow label="Timezone"><span className="text-label text-ink-3">Auto-detect · Africa/Lagos</span></SettingRow>
        <SettingRow label="Ask before acting" note="Vivid checks with you before sending, buying, or changing anything important."><Toggle checked /></SettingRow>
      </SettingsGroup>
    </div>
  );
}

function ComputerSettings() {
  return (
    <div className="mx-auto max-w-3xl space-y-7 pt-3">
      <SettingsGroup label="Vivid's computer">
        <SettingRow label="Status" note="A private computer that stays ready between conversations."><span className="inline-flex items-center gap-1.5 text-label text-success"><i className="size-1.5 rounded-full bg-success" />Ready</span></SettingRow>
        <SettingRow label="Open links in"><span className="text-label text-ink-3">Vivid's browser</span></SettingRow>
      </SettingsGroup>
    </div>
  );
}

function PrivacySettings() {
  return (
    <div className="mx-auto max-w-3xl space-y-7 pt-3">
      <SettingsGroup label="Permissions">
        <SettingRow label="Ask before acting" note="Require approval for actions with an outside effect."><Toggle checked /></SettingRow>
        <SettingRow label="Remember approvals" note="Reuse permissions you marked as always allowed."><Toggle checked={false} /></SettingRow>
      </SettingsGroup>
    </div>
  );
}

function AboutSettings() {
  return (
    <div className="mx-auto max-w-3xl space-y-7 pt-3">
      <SettingsGroup label="Vivid">
        <SettingRow label="Version"><span className="text-label font-meta text-ink-3">Prototype 0.1</span></SettingRow>
        <SettingRow label="Built for"><span className="text-label text-ink-3">Everyday work</span></SettingRow>
      </SettingsGroup>
    </div>
  );
}

function SettingsGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-label font-meta text-ink-3">{label}</h2>
      <div className="overflow-hidden rounded-panel bg-surface-2 ring-line divide-y divide-line-2">{children}</div>
    </section>
  );
}

function SettingRow({ label, note, children }: { label: React.ReactNode; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-4 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-label font-title text-ink">{label}</span>
        {note && <span className="mt-0.5 block max-w-xl text-meta font-meta leading-body text-ink-3">{note}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange?: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange?.(!checked)} className={cn("inline-flex h-6 w-10 items-center rounded-full p-0.5", checked ? "justify-end bg-accent" : "justify-start bg-line-4")}>
      <i className="flex size-5 items-center justify-center rounded-full bg-ink-on-accent shadow-xs">{checked && <Check className="size-3 text-accent" />}</i>
    </button>
  );
}
