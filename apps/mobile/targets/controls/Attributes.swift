import ActivityKit
import Foundation
import Security

/// Both the module and extension compile this file, keeping the APNs Codable contract identical.
@available(iOS 16.2, *)
struct VividActivityAttributes: ActivityAttributes {
  struct Approval: Codable, Hashable {
    let id: String
    let digest: String
    let summary: String
  }
  struct Snapshot: Codable, Hashable {
    let title: String
    let status: String
    let activeCount: Int
    let updatedAt: Double
    let startedAt: Double?
    let approval: Approval?
  }
  struct ContentState: Codable, Hashable { let snapshot: Snapshot }
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
