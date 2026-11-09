import ActivityKit
import ExpoModulesCore
import WidgetKit

/// ActivityKit delivers native token changes even for activities started while JavaScript was suspended.
public final class AwarenessModule: Module {
  private var work: Task<Void, Never>?
  public func definition() -> ModuleDefinition {
    Name("VividAwareness")
    Events("token")
    AsyncFunction("configure") { (server: String, token: String) in
      try NativeAuthority.write(.init(server: server, token: token))
    }
    AsyncFunction("updateWidget") { (snapshot: String) in
      guard let group = Bundle.main.object(forInfoDictionaryKey: "VividAppGroup") as? String,
        let data = snapshot.data(using: .utf8) else { throw CocoaError(.fileWriteNoPermission) }
      _ = try JSONDecoder().decode(VividHomeSnapshot.self, from: data)
      UserDefaults(suiteName: group)?.set(data, forKey: "vivid.widget")
      WidgetCenter.shared.reloadTimelines(ofKind: "VividHome")
    }
    AsyncFunction("clear") {
      try NativeAuthority.clear()
      guard #available(iOS 18.0, *) else { return }
      for activity in Activity<VividActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }
    OnStartObserving {
      guard #available(iOS 18.0, *) else { return }
      self.work = Task {
        await withTaskGroup(of: Void.self) { group in
          group.addTask {
            for await token in Activity<VividActivityAttributes>.pushToStartTokenUpdates {
              self.sendEvent("token", ["kind": "Start", "token": token.map { String(format: "%02x", $0) }.joined()])
            }
          }
          for activity in Activity<VividActivityAttributes>.activities {
            group.addTask { await self.observe(activity) }
          }
          for await activity in Activity<VividActivityAttributes>.activityUpdates {
            group.addTask { await self.observe(activity) }
          }
        }
      }
    }
    OnStopObserving { self.work?.cancel(); self.work = nil }
  }
  /// A rotating update token replaces the server's previous address for this installation.
  @available(iOS 18.0, *)
  private func observe(_ activity: Activity<VividActivityAttributes>) async {
    for await token in activity.pushTokenUpdates {
      self.sendEvent("token", ["kind": "Update", "token": token.map { String(format: "%02x", $0) }.joined()])
    }
  }
}
