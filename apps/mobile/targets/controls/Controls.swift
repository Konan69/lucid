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
  var body: some Widget { VividControl(); VividWorkActivity(); VividHome() }
}

/// Vivid's one Live Activity: what waits on the Person, what Vivid is doing, what just ended.
///
/// Its manners follow T3 Code's agent card (`apps/mobile/src/widgets/AgentActivity.tsx`): one
/// card for all work, never one per Run. The layout is the "Lead" direction Konan chose on
/// 11 Nov 2026 (`~/ref/vivid-design/2026-11-11-feed-liveactivity/variants2.html`): the face leads
/// one column of Threads; each line is the Thread's title and the step Vivid is on (Vivid's own
/// words for the tool call) or how it ended; marks on the right, a dot while working and a tick
/// once done. No timers, no counts, no staleness line, no "Needs you": an approval's question and
/// buttons say it. The Thread that needs the Person takes the card. Every row opens its Thread.
struct VividWorkActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: VividWorkAttributes.self) { context in
      let card = Card(context.state)
      LockCard(face: context.attributes.face, card: card)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .widgetURL(card.link)
    } dynamicIsland: { context in
      let card = Card(context.state)
      let face = context.attributes.face
      return DynamicIsland {
        DynamicIslandExpandedRegion(.bottom) {
          LockCard(face: face, card: card).padding(.horizontal, 4).padding(.bottom, 4)
        }
      } compactLeading: {
        FaceView(face: face, size: 20, mood: card.mood)
      } compactTrailing: {
        CompactMark(card: card)
      } minimal: {
        FaceView(face: face, size: 20, mood: card.mood)
      }
      .widgetURL(card.link)
      .keylineTint(Color(hex: face.fill))
    }
  }
}

/// Everything a view decides from the content, in one place, so the Lock Screen and the Dynamic
/// Island never disagree about what the card is saying.
struct Card {
  let rows: [VividWorkAttributes.Row]
  let approval: VividWorkAttributes.Approval?
  /// Which third of the orbit the dots stand in; it moves with every update, so each push turns
  /// the dots on to their next places and the system animates them there.
  let slot: Int

  init(_ state: VividWorkAttributes.ContentState) {
    rows = state.rows
    approval = state.approval
    slot = Int(state.updatedAt / 1000) % 3
  }

  var hero: VividWorkAttributes.Row? { rows.first }
  var others: ArraySlice<VividWorkAttributes.Row> { rows.dropFirst() }
  var asking: Bool { approval != nil }
  var single: Bool { rows.count <= 1 }
  /// The face tilts as it does in the app (`@vivid/marks` moods): back while working, in when done.
  var mood: FaceMood {
    switch hero?.phase {
    case .Working: return .thinking
    case .Done: return .happy
    default: return .neutral
    }
  }
  /// The card opens the Thread it leads with; the app routes `vivid://thread/<id>`.
  var link: URL? { hero.flatMap { threadLink($0.thread) } }
}

func threadLink(_ thread: String) -> URL? {
  thread.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed).flatMap { URL(string: "vivid://thread/\($0)") }
}

/// The line under a title, or nothing. A finished Run without a sentence says only that.
func line(for row: VividWorkAttributes.Row) -> String? {
  if let said = row.line { return said }
  switch row.phase {
  case .Done: return "Done"
  case .Failed: return "Didn’t finish"
  case .Working, .Approval: return nil
  }
}

/// The first few words of a line, for the Dynamic Island's narrow side.
func short(_ text: String, words: Int = 3) -> String {
  text.split(separator: " ").prefix(words).joined(separator: " ")
}

/// Colour only where it means something: the step Vivid is on, done, or failed.
enum Tint {
  static let working = Color(hex: "#8FB0FF")
  static let done = Color(hex: "#6EE7B7")
  static let failed = Color(hex: "#FCA5A5")
  static func of(_ phase: VividWorkAttributes.Phase, lead: Bool) -> Color {
    switch phase {
    case .Working: return lead ? working : .secondary
    case .Approval: return .secondary
    case .Done: return done
    case .Failed: return failed
    }
  }
}

struct LockCard: View {
  let face: VividWorkAttributes.Face
  let card: Card
  var body: some View {
    if let approval = card.approval, let hero = card.hero {
      Asking(face: face, row: hero, approval: approval, others: card.others.count)
    } else if card.single, let hero = card.hero {
      HStack(alignment: .center, spacing: 12) {
        FaceView(face: face, size: 28, mood: card.mood)
        ThreadLine(row: hero, lead: true, lines: 2)
        Spacer(minLength: 0)
      }
    } else {
      // The face sits centred on the column of Threads.
      HStack(alignment: .center, spacing: 12) {
        FaceView(face: face, size: 28, mood: card.mood)
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Array(card.rows.enumerated()), id: \.element.id) { index, row in
            Link(destination: threadLink(row.thread) ?? URL(string: "vivid://")!) {
              HStack(spacing: 10) {
                ThreadLine(row: row, lead: index == 0, lines: 1)
                Spacer(minLength: 6)
                Mark(phase: row.phase)
              }
            }
          }
        }
      }
    }
  }
}

/// A Thread's title and its line under it.
struct ThreadLine: View {
  let row: VividWorkAttributes.Row
  let lead: Bool
  let lines: Int
  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(row.title)
        .font(.system(size: lead ? 14 : 13, weight: .semibold))
        .lineLimit(1)
      if let said = line(for: row) {
        Text(said)
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(Tint.of(row.phase, lead: lead))
          .lineLimit(lines)
          .fixedSize(horizontal: false, vertical: lines > 1)
      }
    }
  }
}

/// On the right of a row: a dot while Vivid works, a tick once done, a cross if it did not finish.
struct Mark: View {
  let phase: VividWorkAttributes.Phase
  var body: some View {
    switch phase {
    case .Working, .Approval:
      Circle().fill(Tint.working).frame(width: 7, height: 7).frame(width: 18)
    case .Done:
      Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(Tint.done).frame(width: 18)
    case .Failed:
      Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Tint.failed).frame(width: 18)
    }
  }
}

/// The Thread that needs the Person takes the card: its question, its buttons, and the other
/// Threads as small dots beside its title (a Lock Screen card holds about 160 points).
struct Asking: View {
  let face: VividWorkAttributes.Face
  let row: VividWorkAttributes.Row
  let approval: VividWorkAttributes.Approval
  let others: Int
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        FaceView(face: face, size: 28, mood: .neutral)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 8) {
            Text(row.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 6)
            HStack(spacing: 4) {
              ForEach(0..<min(others, 3), id: \.self) { _ in Circle().fill(Tint.working).frame(width: 5, height: 5) }
            }
          }
          Text(approval.summary)
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      HStack(spacing: 8) {
        Button(intent: DecideVividApproval(approval, allow: false)) {
          Text("Don’t allow").frame(maxWidth: .infinity)
        }
        .tint(.secondary)
        if approval.review, let open = threadLink(row.thread) {
          // A draft is reviewed in its Thread; the link is drawn as the filled button would be.
          Link(destination: open) {
            Text("Review").foregroundStyle(.black).frame(maxWidth: .infinity, minHeight: 34)
              .background(Capsule().fill(.white))
          }
        } else {
          Button(intent: DecideVividApproval(approval, allow: true)) {
            Text("Allow once").foregroundStyle(.black).frame(maxWidth: .infinity)
          }
          .tint(.white)
        }
      }
      .font(.system(size: 14, weight: .semibold))
      .buttonStyle(.borderedProminent)
      .buttonBorderShape(.capsule)
    }
  }
}

/// The Dynamic Island's right side, in a few small words or the orbiting dots.
struct CompactMark: View {
  let card: Card
  var body: some View {
    if let approval = card.approval {
      Text(short(approval.summary)).font(.system(size: 12, weight: .semibold)).lineLimit(1)
    } else if !card.single {
      OrbitDots(phases: card.rows.map(\.phase), slot: card.slot)
    } else if let hero = card.hero, let said = line(for: hero) {
      Text(hero.phase == .Working ? short(said) : short(said, words: 1))
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tint.of(hero.phase, lead: true))
        .lineLimit(1)
    } else {
      OrbitDots(phases: card.rows.map(\.phase), slot: card.slot)
    }
  }
}

/// One dot per Thread on a flat, horizontal orbit, as if seen from just above: at the front a dot
/// is larger, brighter and drawn over the others; at the back it is smaller and dimmer. iOS lets a
/// Live Activity animate only when its content changes, so each update moves the dots on by a
/// third of a turn (`Card.slot`) and the system carries them there; they never loop on their own.
struct OrbitDots: View {
  let phases: [VividWorkAttributes.Phase]
  let slot: Int
  var body: some View {
    ZStack {
      ForEach(Array(phases.prefix(3).enumerated()), id: \.offset) { index, phase in
        let angle = (Double(slot + index) / 3 + 0.25) * 2 * .pi
        let depth = sin(angle)
        Circle()
          .fill(phase == .Done ? Tint.done : Tint.working)
          .frame(width: 6, height: 6)
          .scaleEffect(0.875 + 0.325 * depth)
          .opacity(0.775 + 0.225 * depth)
          .offset(x: 8.5 * cos(angle), y: 3 * depth)
          .zIndex(depth)
      }
    }
    .frame(width: 26, height: 16)
    .animation(.smooth(duration: 1.2), value: slot)
    .accessibilityLabel("Vivid is working")
  }
}

/// The face's moods, as `@vivid/marks` names them; only the tilt changes.
enum FaceMood {
  case neutral, thinking, happy
  var tilt: Double {
    switch self {
    case .neutral: return 0
    case .thinking: return -8
    case .happy: return 4
    }
  }
}

/// Vivid's face, drawn the way the app draws it (`@vivid/marks` `faceGeometry`): the chosen
/// outline in the chosen colour, two eyes slightly above centre, each tilted six degrees.
struct FaceView: View {
  let face: VividWorkAttributes.Face
  let size: CGFloat
  var mood: FaceMood = .neutral
  var body: some View {
    let eyeWidth = max(2, (size * 0.11).rounded())
    let eyeHeight = (size * 0.24).rounded()
    let gap = (size * 0.22).rounded()
    let top = size * (0.38 + FaceOutline.eyeDrop(face.outline))
    ZStack(alignment: .topLeading) {
      FaceOutline(name: face.outline).fill(Color(hex: face.fill))
      FaceOutline(name: face.outline).fill(
        RadialGradient(colors: [.white.opacity(0.28), .white.opacity(0)],
          center: UnitPoint(x: 0.32, y: 0.28), startRadius: 0, endRadius: size * 0.55))
      eye(width: eyeWidth, height: eyeHeight, angle: -6)
        .offset(x: (size - eyeWidth * 2 - gap) / 2, y: top)
      eye(width: eyeWidth, height: eyeHeight, angle: 6)
        .offset(x: (size - eyeWidth * 2 - gap) / 2 + eyeWidth + gap, y: top)
    }
    .frame(width: size, height: size)
    .rotationEffect(.degrees(mood.tilt))
    .accessibilityLabel("Vivid")
  }
  private func eye(width: CGFloat, height: CGFloat, angle: Double) -> some View {
    Capsule().fill(Color(hex: face.eyes)).frame(width: width, height: height).rotationEffect(.degrees(angle))
  }
}

/// The eight silhouettes of `@vivid/marks` `FACE_OUTLINE_PATHS`, ported from their 100-unit SVG
/// paths. An outline this does not know is drawn as the default disc.
struct FaceOutline: Shape {
  let name: String

  static func eyeDrop(_ name: String) -> CGFloat {
    switch name {
    case "triangle", "drop": return 0.16
    case "cloud": return 0.04
    default: return 0
    }
  }

  func path(in rect: CGRect) -> Path {
    let s = rect.width / 100
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
    var path = Path()
    switch name {
    case "blob":
      path.move(to: p(52, 5))
      path.addCurve(to: p(97, 50), control1: p(78, 3), control2: p(99, 22))
      path.addCurve(to: p(45, 95), control1: p(95, 79), control2: p(73, 97))
      path.addCurve(to: p(3, 47), control1: p(19, 93), control2: p(1, 75))
      path.addCurve(to: p(52, 5), control1: p(5, 23), control2: p(27, 7))
    case "square":
      path.addRoundedRect(in: CGRect(origin: p(6, 6), size: CGSize(width: 88 * s, height: 88 * s)),
        cornerSize: CGSize(width: 24 * s, height: 24 * s))
    case "pill":
      path.addRoundedRect(in: CGRect(origin: p(0, 20), size: CGSize(width: 100 * s, height: 60 * s)),
        cornerSize: CGSize(width: 30 * s, height: 30 * s))
    case "triangle":
      path.move(to: p(50, 6))
      path.addCurve(to: p(60, 13), control1: p(54, 6), control2: p(58, 8))
      path.addLine(to: p(95, 78))
      path.addCurve(to: p(85, 93), control1: p(99, 86), control2: p(94, 93))
      path.addLine(to: p(15, 93))
      path.addCurve(to: p(5, 78), control1: p(6, 93), control2: p(1, 86))
      path.addLine(to: p(40, 13))
      path.addCurve(to: p(50, 6), control1: p(42, 8), control2: p(46, 6))
    case "hexagon":
      path.move(to: p(43, 7))
      path.addQuadCurve(to: p(57, 7), control: p(50, 3))
      path.addLine(to: p(85, 23))
      path.addQuadCurve(to: p(92, 35), control: p(92, 27))
      path.addLine(to: p(92, 65))
      path.addQuadCurve(to: p(85, 77), control: p(92, 73))
      path.addLine(to: p(57, 93))
      path.addQuadCurve(to: p(43, 93), control: p(50, 97))
      path.addLine(to: p(15, 77))
      path.addQuadCurve(to: p(8, 65), control: p(8, 73))
      path.addLine(to: p(8, 35))
      path.addQuadCurve(to: p(15, 23), control: p(8, 27))
    case "cloud":
      path.move(to: p(26, 90))
      path.addCurve(to: p(2, 66), control1: p(12, 90), control2: p(2, 79))
      path.addCurve(to: p(19, 43), control1: p(2, 55), control2: p(9, 46))
      path.addCurve(to: p(49, 13), control1: p(20, 26), control2: p(33, 13))
      path.addCurve(to: p(77, 30), control1: p(61, 13), control2: p(72, 20))
      path.addCurve(to: p(98, 55), control1: p(89, 31), control2: p(98, 42))
      path.addCurve(to: p(70, 90), control1: p(98, 74), control2: p(86, 90))
    case "drop":
      path.move(to: p(50, 3))
      path.addCurve(to: p(88, 62), control1: p(50, 3), control2: p(88, 40))
      // SVG `A38 38 0 0 1 12 62`: the lower half of a circle about (50, 62), through the bottom.
      path.addArc(center: p(50, 62), radius: 38 * s, startAngle: .degrees(0), endAngle: .degrees(180), clockwise: false)
      path.addCurve(to: p(50, 3), control1: p(12, 40), control2: p(50, 3))
    default:
      path.addEllipse(in: rect)
    }
    path.closeSubpath()
    return path
  }
}

extension Color {
  /// `#RRGGBB` from the app's tokens; anything else draws as the secondary colour.
  init(hex: String) {
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard digits.count == 6, let value = UInt32(digits, radix: 16) else { self = .secondary; return }
    self = Color(
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255
    )
  }
}
