using System;
using System.Collections.Generic;
using System.Windows.Automation;

namespace Vivid.Windows
{
    // Observation caches belong to this process and turn, and to the exact HWND.
    // Capturing only text never grants coordinate authority, or conversely.
    internal sealed class Computer
    {
        private readonly Turn turn;
        private readonly Windows windows = new Windows();
        private readonly Apps apps = new Apps();
        internal int TypingDelivered;
        private readonly Dictionary<string, PictureSnapshot> pictures = new Dictionary<string, PictureSnapshot>();
        private readonly Dictionary<string, TextSnapshot> texts = new Dictionary<string, TextSnapshot>();
        private readonly bool testMode;
        internal Computer(Turn turn, bool testMode) { this.turn = turn; this.testMode = testMode; }
        // Turn authority precedes every observation, inventory and input route; only lifecycle/status bypass it.
        internal object Execute(Request request, Budget budget)
        {
            System.Threading.Interlocked.Exchange(ref TypingDelivered, 0);
            if (request.Method != "begin_turn") turn.Match(request.Turn);
            budget.Check();
            if (request.Method == "begin_turn")
            { turn.Begin(request.Turn); pictures.Clear(); texts.Clear(); apps.Clear(); return new { active = true }; }
            if (request.Method == "end_turn")
            { pictures.Clear(); texts.Clear(); apps.Clear(); turn.End(); return new { active = false }; }
            if (request.Method == "status") return turn.Observe(budget);
            turn.Check();
            budget.Check();
            switch (request.Method)
            {
                case "list_windows": return windows.List(budget);
                case "list_apps": return apps.List(budget);
                case "launch_app": return apps.Launch(request.Parameters, budget);
                case "get_window_state": return State(windows.Resolve(request.Parameters.Object("window")), request.Parameters, budget);
                case "simulate_hook_loss":
                    if (!testMode) throw new UnknownMethod();
                    turn.LoseHookForProof(); return new { };
                case "diagnostic_flood":
                    if (!testMode) throw new UnknownMethod();
                    for (int i = 0; i < 10000; i++) Diagnostics.Write("VividProofDiagnostic");
                    return new { };
                case "diagnostics":
                    if (!testMode) throw new UnknownMethod();
                    return new { activity = Activity.Observe(), foreground = Windows.Diagnostic() };
                case "simulate_escape":
                    if (!testMode) throw new UnknownMethod();
                    turn.Check(); turn.Stop(); return new { stopped = true };
                default: return Act(request, budget);
            }
        }
        // Resolve identity and integrity before mutation; every dispatched attempt revokes prior observations.
        private object Act(Request request, Budget budget)
        {
            switch (request.Method)
            {
                case "activate_window": case "click": case "type_text": case "press_key": case "scroll": break;
                default: throw new UnknownMethod();
            }
            turn.Check();
            Window window = windows.Resolve(request.Parameters.Object("window"));
            var guard = new InputGuard(turn, budget, window);
            Shells.Verify(window);
            Integrity.Verify(window);
            try
            {
                if (request.Method == "press_key") return Press(request.Parameters, guard);
                else ActInput(request, window, guard);
            }
            finally
            {
                // Even uncertain/partial input invalidates both observation authorities.
                pictures.Remove(window.id); texts.Remove(window.id);
            }
            return new { };
        }
        // Chords are parsed before activation. The exact closing chord addresses only
        // its HWND; every keyboard stroke still requires verified foreground authority.
        private static object Press(Fields parameters, InputGuard guard)
        {
            Native.Input[] chord = Input.Chord(parameters.Text("key"));
            if (!Input.ClosesWindow(chord)) guard.Prepare();
            return Input.Press(chord, guard);
        }
        // Keep mutation routing in one place; typing reports its accepted prefix to the watchdog.
        private void ActInput(Request request, Window window, InputGuard guard)
        {
            switch (request.Method)
            {
                case "activate_window": guard.Prepare(); guard.Check(); break;
                case "click": Click(window, request.Parameters, guard); break;
                case "type_text": Type(window, request.Parameters, guard); break;
                case "scroll":
                    CoordinateAuthority(window, request.Parameters);
                    guard.Prepare();
                    Native.Point point = CoordinateAuthority(window, request.Parameters);
                    Input.Scroll(window, point.X, point.Y,
                        request.Parameters.Integer("scrollX"), request.Parameters.Integer("scrollY"), guard); break;
                default: throw new UnknownMethod();
            }
        }
        // Publish observation authority only after all requested captures and the final turn/budget checks succeed.
        private object State(Window window, Fields parameters, Budget budget)
        {
            bool includeText = parameters.Flag("include_text", false);
            bool includePicture = parameters.Flag("include_screenshot", true);
            if (!includeText && !includePicture)
                throw Fields.Invalid("request");
            Shells.Verify(window);
            var result = new Dictionary<string, object> { { "window", window } };
            TextSnapshot textSnapshot = null;
            PictureSnapshot pictureSnapshot = null;
            if (includeText)
            {
                TextSnapshot snapshot = Outline.Read(window, budget);
                textSnapshot = snapshot;
                result.Add("text", snapshot.Text);
                result.Add("truncated", snapshot.Truncated);
            }
            if (includePicture)
            {
                Native.Rect rectangle = Windows.Rectangle(window);
                Picture picture = Capture.Take(window, budget);
                if (!rectangle.Equals(Windows.Rectangle(window)))
                    throw new ScreenshotStale("window moved or resized while capturing; capture again");
                pictureSnapshot = new PictureSnapshot(picture.id, rectangle, picture.width, picture.height);
                result.Add("screenshot", picture);
                result.Add("origin", new { x = rectangle.Left, y = rectangle.Top });
            }
            // A failed observation never grants new authority to a later input request.
            budget.Check(); turn.Check();
            if (textSnapshot != null) texts[window.id] = textSnapshot;
            if (pictureSnapshot != null) pictures[window.id] = pictureSnapshot;
            return result;
        }
        // Accessibility indexes and screenshot pixels require separate, previously observed authorities.
        private void Click(Window window, Fields fields, InputGuard guard)
        {
            int count = fields.Has("click_count") ? fields.Integer("click_count") : 1;
            if (count < 1 || count > 3)
                throw new InvalidClickCount();
            string button = fields.Has("mouse_button") ? fields.Text("mouse_button") : "left";
            if (button != "left" && button != "right" && button != "middle") throw Fields.Invalid("mouse_button");
            if (fields.Has("element_index"))
            {
                Input.Element(window, ObservedElement(window, fields), count, button, guard);
                return;
            }
            CoordinateAuthority(window, fields);
            guard.Prepare();
            Native.Point point = CoordinateAuthority(window, fields);
            Input.Click(window, point.X, point.Y, count, button, guard);
        }
        // Both element mutation routes require indexes from the latest bounded outline.
        private AutomationElement ObservedElement(Window window, Fields fields)
        {
            TextSnapshot snapshot;
            if (!texts.TryGetValue(window.id, out snapshot)) throw new TextRequired();
            int index = fields.Integer("element_index");
            if (index < 0 || index >= snapshot.Elements.Count)
                throw new ElementGone("element_index is not in the latest text snapshot");
            return snapshot.Elements[index];
        }
        // Only an explicitly named element may use SetValue; ordinary type_text retains
        // keyboard semantics and its accepted-prefix progress reporting.
        private void Type(Window window, Fields fields, InputGuard guard)
        {
            string text = fields.Text("text");
            if (text.Length > 4000) throw Fields.Invalid("text length");
            Action<int> progress = delegate(int delivered) { System.Threading.Interlocked.Exchange(ref TypingDelivered, delivered); };
            if (fields.Has("element_index")) Input.ElementType(window, ObservedElement(window, fields), text, guard, progress);
            else { guard.Prepare(); Input.Type(text, guard, progress); }
        }
        // Reject stale picture identity/bounds, then map rounded screenshot dimensions back to physical pixels.
        private Native.Point CoordinateAuthority(Window window, Fields fields)
        {
            PictureSnapshot snapshot;
            if (!pictures.TryGetValue(window.id, out snapshot))
                throw new ScreenshotRequired();
            if (!fields.Has("screenshotId"))
                throw new ScreenshotIdRequired();
            if (fields.Text("screenshotId") != snapshot.Id || !snapshot.Rectangle.Equals(Windows.Rectangle(window)))
                throw new ScreenshotStale("screenshotId or window bounds do not match the latest screenshot; capture again");
            int x = fields.Integer("x"), y = fields.Integer("y");
            if (x < 0 || y < 0 || x >= snapshot.Width || y >= snapshot.Height) throw Fields.Invalid("screenshot coordinate");
            return new Native.Point { X = (int)((long)x * snapshot.Rectangle.Width / snapshot.Width),
                Y = (int)((long)y * snapshot.Rectangle.Height / snapshot.Height) };
        }
    }
}
