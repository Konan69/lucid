import SwiftUI
import WidgetKit

struct HomeEntry: TimelineEntry {
  let date: Date
  let snapshot: VividHomeSnapshot
}

/// The app pushes snapshots into its App Group. WidgetKit reads them without session authority.
struct HomeProvider: TimelineProvider {
  func placeholder(in context: Context) -> HomeEntry { HomeEntry(date: .now, snapshot: .init(rows: [])) }
  func getSnapshot(in context: Context, completion: @escaping (HomeEntry) -> Void) { completion(entry()) }
  func getTimeline(in context: Context, completion: @escaping (Timeline<HomeEntry>) -> Void) {
    completion(Timeline(entries: [entry()], policy: .never))
  }
  private func entry() -> HomeEntry {
    let group = Bundle.main.object(forInfoDictionaryKey: "VividAppGroup") as? String
    let data = group.flatMap { UserDefaults(suiteName: $0)?.data(forKey: "vivid.widget") }
    let snapshot = data.flatMap { try? JSONDecoder().decode(VividHomeSnapshot.self, from: $0) }
    return HomeEntry(date: .now, snapshot: snapshot ?? .init(rows: []))
  }
}

/// Accessory layouts keep one row; Home Screen layouts show up to three without clipping.
struct VividHome: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "VividHome", provider: HomeProvider()) { entry in HomeView(entry: entry) }
      .configurationDisplayName("Vivid at work")
      .description("What Vivid is doing in your Threads.")
      .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
  }
}
struct HomeView: View {
  @Environment(\.widgetFamily) private var family
  let entry: HomeEntry
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if family != .accessoryRectangular { Text("Vivid").font(.caption.weight(.semibold)) }
      ForEach(Array(entry.snapshot.rows.prefix(family == .accessoryRectangular ? 1 : 3))) { row in
        VStack(alignment: .leading, spacing: 1) {
          Text(row.title).font(.subheadline.weight(.medium)).lineLimit(1)
          HStack {
            Text(row.status).lineLimit(1)
            Text(Date(timeIntervalSince1970: row.updatedAt / 1000), style: .relative).lineLimit(1)
          }.font(.caption2).foregroundStyle(.secondary)
        }
      }
      if entry.snapshot.rows.isEmpty { Text("No recent Threads").font(.caption).foregroundStyle(.secondary) }
    }.containerBackground(.background, for: .widget).widgetURL(URL(string: "vivid://"))
  }
}
