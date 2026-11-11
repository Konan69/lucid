import ActivityKit
import ExpoModulesCore
import WidgetKit

/// What the app hands over to start the card: Vivid's face and the first content to show.
@available(iOS 16.2, *)
private struct Arming: Decodable {
  let face: VividWorkAttributes.Face
  let state: VividWorkAttributes.ContentState
}

/// Ten minutes, the same freshness the server's pushes carry (`apps/server/src/activity/apns.ts`).
private let staleAfter: TimeInterval = 10 * 60

/// One Live Activity for Vivid, started here in the foreground and kept up to date by the server.
///
/// The app, not the server, starts the card, because only a card started while the app runs hands
/// its update token over reliably. T3 Code's mobile app made the same choice for its agent card
/// (`remoteRegistration.ts` `refreshActiveLiveActivityRemoteRegistration`: "the relay never
/// remote-starts one"); Vivid's earlier push-to-start left one stale card per Run on the Lock
/// Screen because no token ever came back to update or end them.
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
    /// Makes sure exactly one card is up: ends the old binary's cards and any extra, starts one
    /// if none is live, and answers whether it started one. Calling it again changes nothing.
    AsyncFunction("arm") { (arming: String) async throws -> Bool in
      guard #available(iOS 18.0, *), ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
      for old in Activity<VividActivityAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
      let live = Activity<VividWorkAttributes>.activities.filter {
        $0.activityState == .active || $0.activityState == .stale
      }
      for extra in live.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
      if let kept = live.first {
        // The server may hold an extra's token; hand it the kept card's again.
        if let token = kept.pushToken { self.sendToken(token) }
        return false
      }
      let decoded = try JSONDecoder().decode(Arming.self, from: Data(arming.utf8))
      _ = try Activity.request(
        attributes: VividWorkAttributes(face: decoded.face),
        content: ActivityContent(state: decoded.state, staleDate: Date().addingTimeInterval(staleAfter)),
        pushType: .token,
        style: .standard
      )
      return true
    }
    AsyncFunction("clear") {
      try NativeAuthority.clear()
      guard #available(iOS 18.0, *) else { return }
      for activity in Activity<VividActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
      for activity in Activity<VividWorkAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }
    OnStartObserving {
      guard #available(iOS 18.0, *) else { return }
      self.work = Task {
        await withTaskGroup(of: Void.self) { group in
          for activity in Activity<VividWorkAttributes>.activities {
            group.addTask { await self.observe(activity) }
          }
          for await activity in Activity<VividWorkAttributes>.activityUpdates {
            group.addTask { await self.observe(activity) }
          }
        }
      }
    }
    OnStopObserving { self.work?.cancel(); self.work = nil }
  }
  /// A rotating update token replaces the server's previous address for this installation.
  @available(iOS 18.0, *)
  private func observe(_ activity: Activity<VividWorkAttributes>) async {
    for await token in activity.pushTokenUpdates { sendToken(token) }
  }
  private func sendToken(_ token: Data) {
    sendEvent("token", ["kind": "Update", "token": token.map { String(format: "%02x", $0) }.joined()])
  }
}
