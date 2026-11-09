import AppIntents

/// Siri and Shortcuts reuse the same composer-opening action as the system control.
@available(iOS 18.0, *)
struct VividShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: AskVivid(), phrases: ["Ask \(.applicationName)", "Open \(.applicationName)"],
      shortTitle: "Ask Vivid", systemImageName: "bubble.left.and.text.bubble.right")
  }
}
