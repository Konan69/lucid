using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Vivid.Windows
{
    // LL hooks must live on their installation thread and finish promptly. The pump
    // remains alive while Idle, but hooks exist only during an active turn.
    // Microsoft LowLevelKeyboardProc: timeout removal has no notification; probe
    // both hooks with private tagged, consumed F24-up/same-position mouse events before input.
    internal sealed class Hooks : IDisposable
    {
        private readonly Action stop;
        private readonly Thread thread;
        private readonly ManualResetEvent ready = new ManualResetEvent(false);
        private readonly ManualResetEvent changed = new ManualResetEvent(false);
        private readonly ManualResetEvent keyboardReceipt = new ManualResetEvent(false);
        private readonly ManualResetEvent mouseReceipt = new ManualResetEvent(false);
        private readonly Native.KeyboardCallback keyboardCallback, mouseCallback;
        private IntPtr keyboard, mouse;
        private uint threadId;
        private int probing;
        private long mouseSeen, mouseOwn;
        internal Hooks(Action stop)
        {
            this.stop = stop;
            keyboardCallback = Keyboard; mouseCallback = Mouse;
            thread = new Thread(Pump); thread.IsBackground = true; thread.Start();
            ready.WaitOne();
        }
        // Requests are serialized; installation/removal runs on the hook thread.
        internal void Install() { Command(0x8001); if (keyboard == IntPtr.Zero || mouse == IntPtr.Zero) { Remove(); throw new HookUnavailable(); } }
        // Removal is cleanup on every path (end, stop, dispose, parent exit) and must
        // never throw: a failure is logged and the caller carries on.
        internal void Remove()
        {
            try
            {
                if (Native.GetCurrentThreadId() == threadId) Uninstall();
                else Command(0x8002);
            }
            catch (Exception) { Diagnostics.Write("HookRemovalFailed"); }
        }
        private void Command(uint command)
        {
            changed.Reset();
            if (!Native.PostThreadMessage(threadId, command, UIntPtr.Zero, IntPtr.Zero) || !changed.WaitOne(500))
                throw new HookUnavailable();
        }
        // SendInput's synchronous delivery and receipts distinguish a valid handle
        // from a hook Windows silently removed. Probe events are consumed when live;
        // if missing, key-up/same-position movement cannot type or click. The missing-mouse
        // probe can race cursor movement; ordinary live probes are consumed. Relative
        // zero-motion and zero-wheel events were suppressed in live hook tests.
        internal bool Live(Budget budget)
        {
            if (keyboard == IntPtr.Zero || mouse == IntPtr.Zero) return false;
            keyboardReceipt.Reset(); mouseReceipt.Reset();
            Interlocked.Exchange(ref probing, 1);
            try
            {
                Native.Point point;
                if (!Native.GetCursorPos(out point)) return false;
                int left = Native.GetSystemMetrics(76), top = Native.GetSystemMetrics(77);
                int width = Native.GetSystemMetrics(78), height = Native.GetSystemMetrics(79);
                if (width <= 0 || height <= 0) return false;
                var events = new[] {
                    new Native.Input { Type = 1, Data = new Native.InputUnion { Keyboard = new Native.Keyboard { Key = 0x87, Scan = 0xFFFF, Flags = 2 } } },
                    new Native.Input { Type = 0, Data = new Native.InputUnion { Mouse = new Native.Mouse { Flags = 0xE001,
                        X = (int)(((long)(point.X - left) * 65536 + 32768) / width),
                        Y = (int)(((long)(point.Y - top) * 65536 + 32768) / height) } } }
                };
                if (Activity.Dispatch(events) != events.Length) return false;
                bool live = WaitHandle.WaitAll(new WaitHandle[] { keyboardReceipt, mouseReceipt }, (int)Math.Min(150U, budget.Remaining));
                if (!live) Diagnostics.Write("VividHookProbe keyboard=" + keyboardReceipt.WaitOne(0) + "; mouse=" + mouseReceipt.WaitOne(0) + "; mouseSeen=" + Interlocked.Read(ref mouseSeen) + "; mouseOwn=" + Interlocked.Read(ref mouseOwn));
                return live;
            }
            finally { Interlocked.Exchange(ref probing, 0); }
        }
        // Test mode removes a real native hook without zeroing the saved handle, so
        // the next receipt detects the same stale-handle condition as silent removal.
        internal void LoseForProof() { Command(0x8003); }
        private IntPtr Keyboard(int code, IntPtr message, IntPtr data)
        {
            if (code >= 0)
            {
                var key = (Native.KeyboardEvent)Marshal.PtrToStructure(data, typeof(Native.KeyboardEvent));
                // The helper's own events carry its private tag, so an Escape it types into
                // an app is not a stop. Every other Escape is the Person's and ends the turn.
                if (key.Extra == Activity.OwnInputTag)
                {
                    if (Volatile.Read(ref probing) != 0 && key.Key == 0x87 && (key.Flags & 0x80) != 0)
                    { keyboardReceipt.Set(); return new IntPtr(1); }
                }
                else if (key.Key == 0x1B && (message.ToInt64() == 0x100 || message.ToInt64() == 0x104)) stop();
            }
            return Native.CallNextHookEx(keyboard, code, message, data);
        }
        private IntPtr Mouse(int code, IntPtr message, IntPtr data)
        {
            if (code >= 0)
            {
                Interlocked.Increment(ref mouseSeen);
                var value = (Native.MouseEvent)Marshal.PtrToStructure(data, typeof(Native.MouseEvent));
                if (value.Extra == Activity.OwnInputTag)
                {
                    Interlocked.Increment(ref mouseOwn);
                    if (Volatile.Read(ref probing) != 0) { mouseReceipt.Set(); return new IntPtr(1); }
                }
            }
            return Native.CallNextHookEx(mouse, code, message, data);
        }
        // No pipe I/O, waits, or provider calls execute inside a hook callback.
        private void Uninstall()
        {
            if (keyboard != IntPtr.Zero) Native.UnhookWindowsHookEx(keyboard);
            if (mouse != IntPtr.Zero) Native.UnhookWindowsHookEx(mouse);
            keyboard = IntPtr.Zero; mouse = IntPtr.Zero;
        }
        private void Pump()
        {
            threadId = Native.GetCurrentThreadId();
            Native.Message message;
            Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 0); ready.Set();
            while (Native.GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                if (message.Id == 0x8001)
                {
                    Uninstall();
                    keyboard = Native.SetWindowsHookEx(13, keyboardCallback, Native.GetModuleHandle(null), 0);
                    mouse = Native.SetWindowsHookEx(14, mouseCallback, Native.GetModuleHandle(null), 0);
                    changed.Set();
                }
                else if (message.Id == 0x8002) { Uninstall(); changed.Set(); }
                else if (message.Id == 0x8003) { if (keyboard != IntPtr.Zero) Native.UnhookWindowsHookEx(keyboard); changed.Set(); }
                else { Native.TranslateMessage(ref message); Native.DispatchMessage(ref message); }
            }
            Uninstall();
        }
        public void Dispose()
        {
            try
            {
                Remove(); Native.PostThreadMessage(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero); thread.Join();
                ready.Dispose(); changed.Dispose(); keyboardReceipt.Dispose(); mouseReceipt.Dispose();
            }
            catch (Exception) { Diagnostics.Write("HookDisposeFailed"); }
        }
    }
}
