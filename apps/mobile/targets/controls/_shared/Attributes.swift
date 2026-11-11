import ActivityKit
import Foundation
import Security

/// Both the module and extension compile this file, keeping the APNs Codable contract identical.
///
/// The card's content is `@vivid/contracts` `ActivitySnapshot`, decoded field for field. The face is
/// static for the card's life: the app draws Vivid as the Person set it up when it starts the card.
@available(iOS 16.2, *)
struct VividWorkAttributes: ActivityAttributes {
  /// Vivid's face as the app shows it: fill and eye colours as hex, and the outline's name
  /// (`@vivid/contracts` `FaceOutline`).
  struct Face: Codable, Hashable {
    let fill: String
    let eyes: String
    let outline: String
  }
  struct Approval: Codable, Hashable {
    let id: String
    let digest: String
    let summary: String
    let review: Bool
  }
  enum Phase: String, Codable, Hashable { case Working, Approval, Done, Failed }
  struct Row: Codable, Hashable, Identifiable {
    let thread: String
    let title: String
    let phase: Phase
    /// A step while working, the result once done; absent when there is none to show.
    let line: String?
    var id: String { thread }
  }
  struct ContentState: Codable, Hashable {
    let rows: [Row]
    let activeCount: Int
    let updatedAt: Double
    let approval: Approval?
  }
  let face: Face
}

/// The card type of binaries 0.3.20 and older, which the server started by push, one per Run.
/// It is kept only so the app can end those leftover cards once; delete it with the next native
/// change after 0.3.21.
@available(iOS 16.2, *)
struct VividActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {}
}

/// A shared Keychain item grants native intents the same revocable session as the host app.
enum NativeAuthority {
  struct Session: Codable { let server: String; let token: String }
  static func query() throws -> [String: Any] {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "VividKeychainGroup") as? String else {
      throw CocoaError(.fileReadNoPermission)
    }
    return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "VividNative",
      kSecAttrAccount as String: "session", kSecAttrAccessGroup as String: group]
  }
  static func write(_ session: Session) throws {
    var item = try query()
    let data = try JSONEncoder().encode(session)
    let status = SecItemUpdate(item as CFDictionary, [kSecValueData: data] as CFDictionary)
    if status == errSecItemNotFound {
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw CocoaError(.fileWriteNoPermission) }
    } else if status != errSecSuccess { throw CocoaError(.fileWriteNoPermission) }
  }
  static func clear() throws {
    let status = SecItemDelete(try query() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw CocoaError(.fileWriteNoPermission) }
  }
  static func session() throws -> Session {
    var item = try query()
    item[kSecReturnData as String] = true
    item[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    guard SecItemCopyMatching(item as CFDictionary, &found) == errSecSuccess, let data = found as? Data else {
      throw CocoaError(.fileReadNoPermission)
    }
    return try JSONDecoder().decode(Session.self, from: data)
  }
}

/// The native module and Home Screen extension share one decoded projection of readable Threads.
struct VividHomeSnapshot: Codable {
  struct Row: Codable, Identifiable {
    let id: String
    let title: String
    let status: String
    let updatedAt: Double
  }
  let rows: [Row]
}
