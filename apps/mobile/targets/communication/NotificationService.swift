import UserNotifications
import Intents
import UIKit

/// Communication notifications identify Vivid as the sender. Expiry always returns the original content.
final class NotificationService: UNNotificationServiceExtension {
  private let completionLock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var work: Task<Void, Never>?
  private var best: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    best = request.content
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      finish()
      return
    }
    let payload = content.userInfo["body"] as? [String: Any] ?? content.userInfo
    let opens = payload["opens"] as? [String: Any]
    let thread = opens?["threadId"] as? String
    if let thread { content.threadIdentifier = thread }
    let avatar = UIImage(named: "Avatar").flatMap { $0.pngData() }.map { INImage(imageData: $0) }
    let sender = INPerson(personHandle: INPersonHandle(value: "vivid", type: .unknown), nameComponents: nil,
      displayName: "Vivid", image: avatar, contactIdentifier: nil, customIdentifier: "vivid", isMe: false)
    let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
      content: content.body, speakableGroupName: nil, conversationIdentifier: thread,
      serviceName: nil, sender: sender, attachments: nil)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    work = Task { [weak self] in
      if let address = payload["previewUrl"] as? String, let url = URL(string: address), url.scheme == "https" {
        await self?.attach(url, to: content)
      }
      guard !Task.isCancelled else { return }
      interaction.donate { [weak self] _ in
        guard let self else { return }
        self.completionLock.lock()
        self.best = (try? content.updating(from: intent)) ?? content
        self.completionLock.unlock()
        self.finish()
      }
    }
  }

  /// Only image responses become attachments; a failed preview keeps the readable notification.
  private func attach(_ url: URL, to content: UNMutableNotificationContent) async {
    do {
      let (temporary, response) = try await URLSession.shared.download(from: url)
      defer { try? FileManager.default.removeItem(at: temporary) }
      guard let response = response as? HTTPURLResponse, response.statusCode == 200,
        let mime = response.mimeType,
        let suffix = ["image/png": "png", "image/jpeg": "jpg", "image/gif": "gif"][mime],
        let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 8 * 1024 * 1024 else { return }
      let image = temporary.deletingLastPathComponent().appendingPathComponent(UUID().uuidString).appendingPathExtension(suffix)
      try FileManager.default.moveItem(at: temporary, to: image)
      defer { try? FileManager.default.removeItem(at: image) }
      content.attachments = [try UNNotificationAttachment(identifier: "preview", url: image)]
    } catch { return }
  }

  /// Donation completion and the extension deadline compete for one completion handler.
  private func finish() {
    completionLock.lock()
    let callback = handler
    let content = best
    handler = nil
    completionLock.unlock()
    if let callback, let content { callback(content) }
  }

  override func serviceExtensionTimeWillExpire() { work?.cancel(); finish() }
}
