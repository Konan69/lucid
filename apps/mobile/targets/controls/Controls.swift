import ActivityKit
import Foundation
import AppIntents
import SwiftUI
import WidgetKit

/// The same action is available on the Lock Screen and in Control Center.
struct VividControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "work.vivid.ask") {
      ControlWidgetButton(action: AskVivid()) { Label("Ask Vivid", systemImage: "bubble.left.and.text.bubble.right") }
    }.displayName("Ask Vivid")
  }
}

@main
struct VividControls: WidgetBundle {
  var body: some Widget { VividControl(); VividRunActivity(); VividHome() }
}

/// Native buttons invoke the app's intent without requiring JavaScript or presenting app UI.
struct VividRunActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: VividActivityAttributes.self) { context in
      VStack(alignment: .leading, spacing: 8) {
        HStack { Image("Avatar").resizable().frame(width: 24, height: 24).clipShape(Circle()); Text("Vivid").font(.caption.weight(.semibold)) }
        Text(context.state.snapshot.title).font(.headline).lineLimit(1)
        Text(context.isStale ? "Last update" : context.state.snapshot.status).font(.subheadline).foregroundStyle(.secondary)
        if let started = context.state.snapshot.startedAt { Text(Date(timeIntervalSince1970: started / 1000), style: .timer).font(.caption.monospacedDigit()) }
        if let approval = context.state.snapshot.approval {
          Text(approval.summary).font(.subheadline).lineLimit(2)
          HStack {
            Button("Don’t allow", intent: DecideVividApproval(approval, allow: false))
            if approval.review {
              if let url = URL(string: "vivid://") { Link("Review", destination: url) }
            } else { Button("Allow once", intent: DecideVividApproval(approval, allow: true)) }
          }.buttonStyle(.bordered)
        }
      }.padding().widgetURL(URL(string: "vivid://"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.center) { Text(context.state.snapshot.title).lineLimit(1) }
        DynamicIslandExpandedRegion(.bottom) {
          if let approval = context.state.snapshot.approval {
            VStack {
              Text(approval.summary).lineLimit(2)
              HStack {
                Button("Don’t allow", intent: DecideVividApproval(approval, allow: false))
                if approval.review {
              if let url = URL(string: "vivid://") { Link("Review", destination: url) }
            } else { Button("Allow once", intent: DecideVividApproval(approval, allow: true)) }
              }
            }
          } else { Text(context.state.snapshot.status) }
        }
      } compactLeading: { Image("Avatar").resizable().frame(width: 18, height: 18).clipShape(Circle()) } compactTrailing: {
        Text(context.state.snapshot.activeCount, format: .number)
      } minimal: { Image("Avatar").resizable().frame(width: 18, height: 18).clipShape(Circle()) }
    }
  }
}
