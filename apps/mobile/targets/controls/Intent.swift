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
