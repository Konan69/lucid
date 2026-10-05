using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

namespace Vivid.Windows
{
    internal sealed class Window
    {
        public string app { get; set; }
        public string id { get; set; }
        public uint pid { get; set; }
        public string inputAccess { get; set; }
        public string title { get; set; }
        internal IntPtr Handle;
    }
    internal sealed class WindowIdentity
    {
        internal readonly IntPtr Handle;
        internal readonly uint Process;
        internal readonly long Started;
        internal readonly string Class;
        internal WindowIdentity(IntPtr handle, uint process, long started, string className)
        { Handle = handle; Process = process; Started = started; Class = className; }
    }

    // Window handles are session identities. Binding each observed handle to the process's
    // creation time prevents a recycled handle from authorizing input to another application.
    internal sealed class Windows
    {
        private readonly string session = Guid.NewGuid().ToString("N");
        private readonly Dictionary<string, WindowIdentity> identities = new Dictionary<string, WindowIdentity>();
        // Refresh every handle identity; enumeration races skip vanished windows without poisoning the next list.
        internal List<Window> List(Budget budget)
        {
            identities.Clear();
            var windows = new List<Window>();
            Failure failure = null;
            Native.EnumWindows(delegate(IntPtr handle, IntPtr unused)
            {
                if (!Native.IsWindowVisible(handle)) return true;
                try { budget.Check(); windows.Add(Observe(handle)); }
                catch (WindowGone) { return true; }
                catch (Failure error) { failure = error; return false; }
                catch (System.ComponentModel.Win32Exception) { return true; }
                catch (InvalidOperationException) { return true; }
                catch (ArgumentException) { return true; }
                return true;
            }, IntPtr.Zero);
            if (failure != null) throw failure;
            return windows;
        }
        // Each observation reads current identity; enumeration never consults a stale handle.
        private Window Observe(IntPtr handle)
        {
            uint processId;
            Native.GetWindowThreadProcessId(handle, out processId);
            using (Process process = Process.GetProcessById((int)processId))
            {
                var text = new StringBuilder(4096);
                Native.GetWindowText(handle, text, text.Capacity);
                long started = process.StartTime.ToUniversalTime().Ticks;
                var className = new StringBuilder(256);
                if (!Native.IsWindow(handle) || Native.GetClassName(handle, className, className.Capacity) == 0) throw Gone();
                // The wire id binds identity as well as HWND. Re-listing a recycled HWND
                // can expose its new id without granting authority to an old saved id.
                string id = session + ":" + handle.ToInt64().ToString("X") + ":" + processId.ToString("X") + ":" + started.ToString("X") + ":" + className.ToString();
                identities[id] = new WindowIdentity(handle, processId, started, className.ToString());
                return new Window { app = process.ProcessName, id = id, Handle = handle, pid = processId,
                    inputAccess = Integrity.ForProcess(processId).ToString(), title = text.ToString() };
            }
        }
        // Only a specifically requested handle is refused for identity drift; never silently rebind its authority.
        internal Window Resolve(Fields fields)
        {
            string id = fields.Text("id");
            string app = fields.Text("app");
            WindowIdentity expected;
            if (!identities.TryGetValue(id, out expected)) throw Gone();
            IntPtr handle = expected.Handle;
            if (!Native.IsWindow(handle)) throw Gone();
            uint processId;
            Native.GetWindowThreadProcessId(handle, out processId);
            if (processId != expected.Process) throw Gone();
            try
            {
                Window current = Observe(handle);
                if (current.id != id || current.app != app)
                { identities.Remove(id); throw Gone(); }
                return current;
            }
            catch (System.ComponentModel.Win32Exception) { throw Gone(); }
            catch (InvalidOperationException) { throw Gone(); }
            catch (ArgumentException) { throw Gone(); }
        }
        // Unusable native bounds are a gone-window failure, never fabricated screenshot dimensions.
        internal static Native.Rect Rectangle(Window window)
        {
            Native.Rect rect;
            if (!Native.GetWindowRect(window.Handle, out rect) || rect.Width <= 0 || rect.Height <= 0) throw Gone();
            return rect;
        }
        internal static Failure Gone()
        { return new WindowGone(); }
        // The inspected notes expose activation but do not specify native focus internals.
        // Round-three design: attach input queues only while the Person is idle, restore,
        // bring forward and detach in finally; never synthesize an Alt/key gesture.
        // Microsoft AttachThreadInput requires message queues and distinct thread ids.
        internal static void Activate(Window window, Budget budget)
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                budget.Check(); Activity.RequireIdle();
                if (IsForeground(window) && !Native.IsIconic(window.Handle)) return;
                Focus(window);
                Receipt(window, budget);
                Activity.RequireIdle();
                if (IsForeground(window)) return;
            }
            Foreground(window);
        }
        // Queue attachment is temporary even on restore/activation failure. A request
        // watchdog bounds a blocked native call; receipt/retry never replays input.
        private static void Focus(Window window)
        {
            Native.Message message;
            Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
            uint current = Native.GetCurrentThreadId(), process;
            uint foreground = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out process);
            uint target = Native.GetWindowThreadProcessId(window.Handle, out process);
            var gui = new Native.GuiThread { Size = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(Native.GuiThread)) };
            uint focused = 0;
            if (Native.GetGUIThreadInfo(0, ref gui) && gui.Focus != IntPtr.Zero)
                focused = Native.GetWindowThreadProcessId(gui.Focus, out process);
            bool attachedForeground = false, attachedTarget = false, attachedFocus = false;
            try
            {
                if (foreground != 0 && foreground != current)
                    attachedForeground = Native.AttachThreadInput(current, foreground, true);
                if (target != current && target != foreground)
                    attachedTarget = Native.AttachThreadInput(current, target, true);
                // UWP frames can host focus in a client process/thread different from
                // the frame HWND's thread. Attach that actual foreground input queue too.
                if (focused != 0 && focused != current && focused != foreground && focused != target)
                    attachedFocus = Native.AttachThreadInput(current, focused, true);
                Activity.RequireIdle();
                if (Native.IsIconic(window.Handle)) Native.ShowWindow(window.Handle, 9);
                Activity.RequireIdle();
                bool brought = Native.BringWindowToTop(window.Handle);
                bool accepted = Native.SetForegroundWindow(window.Handle);
                if (!accepted || !IsForeground(window))
                    Console.Error.WriteLine("VividActivationDenied attachedForeground=" + attachedForeground +
                        "; attachedTarget=" + attachedTarget + "; attachedFocus=" + attachedFocus + "; focusThread=" + focused + "; brought=" + brought + "; accepted=" + accepted +
                        "; currentThread=" + current + "; foregroundThread=" + foreground + "; targetThread=" + target + "; " + Diagnostic());
            }
            finally
            {
                if (attachedFocus) Native.AttachThreadInput(current, focused, false);
                if (attachedTarget) Native.AttachThreadInput(current, target, false);
                if (attachedForeground) Native.AttachThreadInput(current, foreground, false);
            }
        }
        // The activation receipt orders cross-queue focus before its first input batch.
        // It is not an acknowledgement that an application interpreted typed characters.
        internal static void Receipt(Window window, Budget budget)
        {
            UIntPtr unused;
            if (Native.SendMessageTimeout(window.Handle, 0, UIntPtr.Zero, IntPtr.Zero, 2,
                Math.Min(1000U, budget.Remaining), out unused) == IntPtr.Zero)
                throw new NativeInputFailed("named window did not acknowledge its input queue; do not retry automatically", 0);
            budget.Check();
        }
        // DefWindowProc's documented SC_CLOSE is the native equivalent of Alt+F4,
        // addressed to the named HWND. A timeout is uncertain and is never replayed.
        // learn.microsoft.com/windows/win32/menurc/wm-syscommand
        internal static void Close(Window window, Budget budget)
        {
            UIntPtr unused;
            if (Native.SendMessageTimeout(window.Handle, 0x112, new UIntPtr(0xF060), IntPtr.Zero,
                2, budget.Remaining, out unused) == IntPtr.Zero)
                throw new NativeInputFailed("named window did not acknowledge close; do not retry automatically", 0);
            budget.Check();
        }
        // Diagnostics contain only a class, process name and idle age; never window text.
        internal static string Diagnostic()
        {
            IntPtr foreground = Native.GetForegroundWindow();
            var name = new StringBuilder(256);
            Native.GetClassName(foreground, name, name.Capacity);
            uint pid;
            Native.GetWindowThreadProcessId(foreground, out pid);
            string processName;
            try { using (Process process = Process.GetProcessById((int)pid)) processName = process.ProcessName; }
            catch (ArgumentException) { processName = "unavailable"; }
            catch (InvalidOperationException) { processName = "unavailable"; }
            catch (System.ComponentModel.Win32Exception) { processName = "unavailable"; }
            var input = new Native.LastInput { Size = 8 };
            string idle = Native.GetLastInputInfo(ref input) ? unchecked(Native.GetTickCount() - input.Time).ToString() : "unavailable";
            return "foregroundClass=" + name + "; foregroundProcess=" + processName + "; lastInputAgeMs=" + idle;
        }
        // A foreground child/owned popup is acceptable only when its root owner IS the
        // explicitly named HWND, never merely another window in the same process.
        private static bool IsForeground(Window window)
        { return Native.GetAncestor(Native.GetForegroundWindow(), 3) == window.Handle; }
        // Recheck immediately before each global batch; class/process diagnostics omit titles.
        internal static void Foreground(Window window)
        {
            if (!Native.IsWindow(window.Handle)) throw Gone();
            if (!IsForeground(window))
                throw new ForegroundRefused("the named window could not be verified as the foreground window; no input sent; " + Diagnostic());
        }
    }
}
