using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace Vivid.Windows
{
    internal sealed class InputGuard
    {
        private readonly Turn turn;
        private readonly Budget budget;
        private readonly Window window;
        internal InputGuard(Turn turn, Budget budget, Window window)
        { this.turn = turn; this.budget = budget; this.window = window; }
        // Mapping belongs to the target's keyboard layout, not the helper's thread.
        internal short CharacterKey(char character)
        {
            uint process;
            uint thread = Native.GetWindowThreadProcessId(window.Handle, out process);
            return Native.VkKeyScanEx(character, Native.GetKeyboardLayout(thread));
        }
        // SendInput is global: recheck before each batch, while acknowledging Windows
        // offers no atomic HWND-verify-and-inject operation.
        internal void CheckTarget() { turn.Check(); budget.Check(); Shells.Verify(window); Integrity.Verify(window); turn.RequireInput(budget); }
        internal void Check() { CheckTarget(); Activity.RequireIdle(); Windows.Foreground(window); }
        // Pointer/keyboard fallback activates only after identity, stop and Person-idle checks.
        internal void Prepare() { CheckTarget(); Activity.RequireIdle(); Windows.Activate(window, budget); }
        // SC_CLOSE is addressed to the validated HWND, so Alt+F4 cannot close a different
        // foreground window if focus changes between validation and global SendInput.
        internal object Close() { CheckTarget(); return Windows.Close(window, budget); }
        // Hosted accessibility controls may belong to a different process than the HWND.
        internal void CheckElement(AutomationElement element)
        {
            CheckTarget();
            int id = element.Current.ProcessId;
            if (id <= 0) throw new ElevatedTarget();
            uint process = (uint)id;
            Shells.VerifyProcess(process);
            if (Integrity.ForProcess(process) != TargetAccess.Allowed) throw new ElevatedTarget();
        }
    }

    internal static class Input
    {
        internal static void Click(Window window, int x, int y, int count, string button, InputGuard guard)
        {
            guard.Prepare();
            Native.Rect rect = Windows.Rectangle(window);
            var point = new Native.Point { X = rect.Left + x, Y = rect.Top + y };
            VerifyPoint(window, rect, point);
            uint down, up;
            Button(button, out down, out up);
            var events = new List<Native.Input>();
            events.Add(Pointer(point));
            for (int i = 0; i < count; i++)
            { events.Add(Mouse(down, 0)); events.Add(Mouse(up, 0)); }
            Send(events.ToArray(), guard);
        }
        // Invoke respects the application's accessibility contract. Non-left clicks or
        // repeated clicks need actual pointer events rather than an unrelated invocation.
        // Invoke/Toggle/Select need hook/target/Person-idle authority, but no foreground.
        internal static void Element(Window window, AutomationElement element, int count, string button, InputGuard guard)
        {
            try { ElementInput(window, element, count, button, guard); }
            catch (ElementNotAvailableException) { throw new ElementGone("the accessibility element is no longer available"); }
            catch (ElementNotEnabledException) { throw new ElementGone("the accessibility element is disabled"); }
            catch (InvalidOperationException) { throw new AccessibilityFailed(); }
            catch (COMException) { throw new AccessibilityFailed(); }
        }
        // Read the live provider element, then invoke or dispatch pointer events to its current bounds.
        private static void ElementInput(Window window, AutomationElement element, int count, string button, InputGuard guard)
        {
            guard.CheckElement(element);
            if (!element.Current.IsEnabled) throw new ElementGone("the accessibility element is disabled");
            object pattern;
            if (count == 1 && button == "left" && element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
            { guard.CheckElement(element); ((InvokePattern)pattern).Invoke(); Diagnostics.Write("VividInputPattern=InvokePattern"); return; }
            if (count == 1 && button == "left" && element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
            { guard.CheckElement(element); ((TogglePattern)pattern).Toggle(); Diagnostics.Write("VividInputPattern=TogglePattern"); return; }
            if (count == 1 && button == "left" && element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            { guard.CheckElement(element); ((SelectionItemPattern)pattern).Select(); Diagnostics.Write("VividInputPattern=SelectionItemPattern"); return; }
            guard.Prepare();
            var bounds = element.Current.BoundingRectangle;
            if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0)
                throw new ElementGone("the accessibility element has no clickable bounds");
            Native.Rect rect = Windows.Rectangle(window);
            Click(window, (int)Math.Round(bounds.X + bounds.Width / 2) - rect.Left,
                (int)Math.Round(bounds.Y + bounds.Height / 2) - rect.Top, count, button, guard);
        }
        // Explicit element typing uses ValuePattern without focus. A provider lacking
        // that pattern needs a guarded pointer focus followed by the ordinary typing path.
        internal static void ElementType(Window window, AutomationElement element, string text, InputGuard guard, Action<int> progress)
        {
            if (text.Length > 4000) throw Fields.Invalid("text length");
            try
            {
                guard.CheckElement(element);
                if (!element.Current.IsEnabled) throw new ElementGone("the accessibility element is disabled");
                object pattern;
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    var value = (ValuePattern)pattern;
                    if (value.Current.IsReadOnly) throw new ElementGone("the accessibility value is read-only");
                    guard.CheckElement(element); value.SetValue(text);
                    Diagnostics.Write("VividInputPattern=ValuePattern.SetValue"); return;
                }
                guard.Prepare();
                var bounds = element.Current.BoundingRectangle;
                if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0)
                    throw new ElementGone("the accessibility element has no clickable bounds");
                Native.Rect rect = Windows.Rectangle(window);
                Click(window, (int)Math.Round(bounds.X + bounds.Width / 2) - rect.Left,
                    (int)Math.Round(bounds.Y + bounds.Height / 2) - rect.Top, 1, "left", guard);
                Type(text, guard, progress);
            }
            catch (ElementNotAvailableException) { throw new ElementGone("the accessibility element is no longer available"); }
            catch (ElementNotEnabledException) { throw new ElementGone("the accessibility element is disabled"); }
            catch (InvalidOperationException) { throw new AccessibilityFailed(); }
            catch (COMException) { throw new AccessibilityFailed(); }
        }
        // Count UTF-16 units whose character keydown Windows accepted, including a
        // partial native batch. A later refusal carries that count; never replay a prefix.
        // Balanced layout/Unicode batches keep the clipboard untouched.
        internal static void Type(string text, InputGuard guard, Action<int> progress)
        {
            if (text.Length > 4000) throw Fields.Invalid("text length");
            int delivered = 0;
            try
            {
                foreach (char character in text)
                {
                    CharacterStroke stroke = Character(character, guard.CharacterKey(character));
                    try { Send(stroke.Events, guard); }
                    catch (NativeInputFailed error)
                    { if (error.Inserted > stroke.CharacterDown) { delivered++; progress(delivered); } throw; }
                    delivered++; progress(delivered);
                }
            }
            catch (Failure error) { throw new TypingInterrupted(delivered, error); }
        }
        private sealed class CharacterStroke
        {
            internal readonly Native.Input[] Events;
            internal readonly int CharacterDown;
            internal CharacterStroke(Native.Input[] events, int characterDown) { Events = events; CharacterDown = characterDown; }
        }
        // Prefer a target-layout keystroke when it needs at most Shift. VK_PACKET is
        // reserved for unmapped Unicode; WinUI Notepad coalesced rapid mapped packets
        // in live proof. Ctrl/Alt mappings never become system actions while typing.
        private static CharacterStroke Character(char character, short mapped)
        {
            if (mapped == -1 || (mapped & 0xFE00) != 0)
                return new CharacterStroke(new[] { Key(0, character, 4), Key(0, character, 6) }, 0);
            ushort key = (ushort)(mapped & 0xFF);
            if ((mapped & 0x100) == 0)
                return new CharacterStroke(new[] { Key(key, 0, 0), Key(key, 0, 2) }, 0);
            return new CharacterStroke(new[] { Key(0x10, 0, 0), Key(key, 0, 0), Key(key, 0, 2), Key(0x10, 0, 2) }, 1);
        }
        // Parse the closed key vocabulary and refuse global system chords before any activation or dispatch.
        internal static Native.Input[] Chord(string chord)
        {
            string[] names = chord.Split('+');
            var keys = new List<ushort>();
            foreach (string name in names) keys.Add(ParseKey(name.Trim()));
            if (keys.Count > 8) throw Fields.Invalid("key chord length");
            if (keys.Contains(0x5B) || keys.Contains(0x5C) ||
                keys.Contains(0x12) && (keys.Contains(0x09) || keys.Contains(0x1B)) ||
                keys.Contains(0x11) && keys.Contains(0x1B) ||
                keys.Contains(0x11) && keys.Contains(0x12) && keys.Contains(0x2E)) throw new SystemChordRefused();
            var events = new List<Native.Input>();
            foreach (ushort key in keys) events.Add(Key(key, 0, Extended(key)));
            for (int i = keys.Count - 1; i >= 0; i--) events.Add(Key(keys[i], 0, Extended(keys[i]) | 2));
            return events.ToArray();
        }
        // Only the exact two-key closing chord may bypass global keyboard injection.
        internal static bool ClosesWindow(Native.Input[] chord)
        {
            return chord.Length == 4 &&
                (chord[0].Data.Keyboard.Key == 0x12 && chord[1].Data.Keyboard.Key == 0x73 ||
                 chord[1].Data.Keyboard.Key == 0x12 && chord[0].Data.Keyboard.Key == 0x73);
        }
        internal static object Press(Native.Input[] chord, InputGuard guard)
        { if (ClosesWindow(chord)) return guard.Close(); Send(chord, guard); return new { }; }
        // scrollX/Y are signed Windows wheel units (120 per notch), not pixels.
        // Keep both axes in one balanced native batch after verifying its origin point.
        internal static void Scroll(Window window, int x, int y, int horizontal, int vertical, InputGuard guard)
        {
            if (Math.Abs((long)horizontal) > 2400 || Math.Abs((long)vertical) > 2400) throw Fields.Invalid("scroll delta");
            guard.Prepare();
            Native.Rect rect = Windows.Rectangle(window);
            var point = new Native.Point { X = rect.Left + x, Y = rect.Top + y };
            VerifyPoint(window, rect, point);
            var events = new List<Native.Input>();
            events.Add(Pointer(point));
            if (horizontal != 0) events.Add(Mouse(0x1000, unchecked((uint)horizontal)));
            if (vertical != 0) events.Add(Mouse(0x800, unchecked((uint)-vertical)));
            Send(events.ToArray(), guard);
        }
        private static void VerifyPoint(Window window, Native.Rect rect, Native.Point point)
        {
            if (point.X < rect.Left || point.Y < rect.Top || point.X >= rect.Right || point.Y >= rect.Bottom)
                throw Fields.Invalid("window-relative coordinate");
            if (point.X < 0 || point.Y < 0 || point.X >= Native.GetSystemMetrics(0) || point.Y >= Native.GetSystemMetrics(1))
                throw new NativeInputFailed("pointer input is limited to the primary display", 0);
            if (Native.GetAncestor(Native.WindowFromPoint(point), 2) != window.Handle)
                throw new ForegroundRefused("the named window does not own the input point; no input sent; " + Windows.Diagnostic());
        }
        private static void Button(string button, out uint down, out uint up)
        {
            switch (button)
            {
                case "left": down = 2; up = 4; return;
                case "right": down = 8; up = 16; return;
                case "middle": down = 32; up = 64; return;
                default: throw Fields.Invalid("mouse_button");
            }
        }
        private static Native.Input Pointer(Native.Point point)
        {
            // Map physical primary-display pixels into SendInput's 0..65535 absolute space.
            return new Native.Input { Type = 0, Data = new Native.InputUnion { Mouse = new Native.Mouse {
                X = (int)Math.Round(point.X * 65535.0 / (Native.GetSystemMetrics(0) - 1)),
                Y = (int)Math.Round(point.Y * 65535.0 / (Native.GetSystemMetrics(1) - 1)), Flags = 0x8001 } } };
        }
        private static Native.Input Mouse(uint flags, uint data)
        { return new Native.Input { Type = 0, Data = new Native.InputUnion { Mouse = new Native.Mouse { Flags = flags, Data = data } } }; }
        private static Native.Input Key(ushort key, ushort scan, uint flags)
        { return new Native.Input { Type = 1, Data = new Native.InputUnion { Keyboard = new Native.Keyboard { Key = key, Scan = scan, Flags = flags } } }; }
        private static uint Extended(ushort key)
        { return key >= 0x21 && key <= 0x2E || key == 0x5B || key == 0x5C || key == 0x6F ? 1U : 0U; }
        // Check target/modifiers before dispatch. Recover releases for accepted downs, never replay the action.
        private static void Send(Native.Input[] events, InputGuard guard)
        {
            guard.Check();
            foreach (int key in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
                if ((Native.GetAsyncKeyState(key) & 0x8000) != 0)
                    throw new ModifierHeld();
            uint sent = Activity.Dispatch(events);
            if (sent != events.Length)
            {
                // Release only keys/buttons this batch actually inserted; never retry input.
                var releases = new List<Native.Input>();
                for (int i = 0; i < sent; i++)
                {
                    Native.Input item = events[i];
                    if (item.Type == 1 && (item.Data.Keyboard.Flags & 2) == 0)
                    { item.Data.Keyboard.Flags |= 2; releases.Add(item); }
                    if (item.Type == 0 && (item.Data.Mouse.Flags & (2 | 8 | 32)) != 0)
                    { item.Data.Mouse.Flags <<= 1; releases.Add(item); }
                }
                if (releases.Count > 0)
                { Activity.Dispatch(releases.ToArray()); }
                throw new NativeInputFailed("SendInput did not insert the complete batch; do not retry automatically", sent);
            }
        }
        private static ushort ParseKey(string name)
        {
            ushort named;
            if (NamedKeys.TryGetValue(name, out named)) return named;
            if (name.Length == 1 && (name[0] >= 'a' && name[0] <= 'z' || name[0] >= 'A' && name[0] <= 'Z' || name[0] >= '0' && name[0] <= '9')) return (ushort)Char.ToUpperInvariant(name[0]);
            if (name.Length >= 2 && name[0] == 'F')
            {
                int number;
                if (Int32.TryParse(name.Substring(1), out number) && number >= 1 && number <= 24) return (ushort)(0x6F + number);
            }
            throw Fields.Invalid("key");
        }
        private static readonly Dictionary<string, ushort> NamedKeys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            {"Escape",0x1B}, {"Esc",0x1B}, {"Return",0x0D}, {"Enter",0x0D}, {"Tab",0x09}, {"space",0x20},
            {"BackSpace",0x08}, {"Delete",0x2E}, {"Del",0x2E}, {"Insert",0x2D}, {"Home",0x24}, {"End",0x23},
            {"Page_Up",0x21}, {"Page_Down",0x22}, {"Left",0x25}, {"Up",0x26}, {"Right",0x27}, {"Down",0x28},
            {"Ctrl",0x11}, {"Control",0x11}, {"Control_L",0x11}, {"Alt",0x12}, {"Alt_L",0x12},
            {"Shift",0x10}, {"Shift_L",0x10}, {"Win",0x5B}, {"Windows",0x5B}, {"Super_L",0x5B}, {"Super_R",0x5C}, {"Win_R",0x5C},
            {"multiply",0x6A}, {"asterisk",0x6A}, {"add",0x6B}, {"plus",0x6B}, {"subtract",0x6D},
            {"divide",0x6F}, {"equal",0xBB}, {"period",0xBE}, {"comma",0xBC}, {"minus",0xBD},
            {"KP_0",0x60}, {"KP_1",0x61}, {"KP_2",0x62}, {"KP_3",0x63}, {"KP_4",0x64},
            {"KP_5",0x65}, {"KP_6",0x66}, {"KP_7",0x67}, {"KP_8",0x68}, {"KP_9",0x69}
        };
    }
}
