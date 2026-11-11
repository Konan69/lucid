import Foundation
import AppIntents

/// The system opens Vivid through its registered scheme, preserving its normal sign-in boundary.
@available(iOS 18.0, *)
struct AskVivid: AppIntent {
  static var title: LocalizedStringResource = "Ask Vivid"
  static var description = IntentDescription("Open Vivid to start a conversation.")
  static var openAppWhenRun = true

  func perform() async throws -> some IntentResult & OpensIntent {
    guard let url = URL(string: "vivid://") else { throw URLError(.badURL) }
    return .result(opensIntent: OpenURLIntent(url))
  }
}

@available(iOS 18.0, *)
/// Approval decisions remain bound to the exact digest shown on this Lock Screen card.
struct DecideVividApproval: LiveActivityIntent {
  static var title: LocalizedStringResource = "Answer Vivid"
  static var isDiscoverable = false
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Approval") var id: String
  @Parameter(title: "Digest") var digest: String
  @Parameter(title: "Allow") var allow: Bool
  init() {}
  init(_ approval: VividWorkAttributes.Approval, allow: Bool) {
    id = approval.id; digest = approval.digest; self.allow = allow
  }
  func perform() async throws -> some IntentResult {
    let session = try NativeAuthority.session()
    guard let base = URL(string: session.server), base.scheme == "https" else { throw URLError(.badURL) }
    var request = URLRequest(url: base.appendingPathComponent("api/activity/action"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["_tag": "Approval", "request": [
      "id": id, "digest": digest, "decision": ["_tag": allow ? "AllowOnce" : "Deny"]]])
    let (_, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 204 else { throw URLError(.badServerResponse) }
    return .result()
  }
}

