using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Vivid.Windows
{
    internal enum TurnPhase { Idle, Active, Stopped }

    // The hook and the test request call the same Stop method. Injected Escape belongs
    // to a target application and must never be mistaken for the Person's stop gesture.
    internal sealed class Turn : IDisposable
    {
        private int phase;
        private string identity;
        private readonly System.Collections.Generic.HashSet<string> stoppedIds = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
        private readonly object transitions = new object();
        private readonly Thread thread;
        private readonly ManualResetEvent ready = new ManualResetEvent(false);
        private readonly Native.KeyboardCallback callback;
        private readonly Native.KeyboardCallback mouseCallback;
        private IntPtr mouseHook;
        private IntPtr hook;
        private uint threadId;
        private readonly Notice notice = new Notice();
        private readonly Action stopped;
        internal Turn(Action stopped)
        {
            this.stopped = stopped;
            Activity.Initialize();
            callback = Keyboard;
            mouseCallback = Mouse;
            thread = new Thread(Pump);
            thread.IsBackground = true;
            thread.Start();
            ready.WaitOne();
            if (hook == IntPtr.Zero || mouseHook == IntPtr.Zero) throw new NativeInputFailed("could not install physical input hooks", 0);
        }
        // A stopped identity is never reusable, even after other turns have run.
        // Repeating an active begin is idempotent and cannot silently replace its owner.
        internal void Begin(string id)
        {
            lock (transitions)
            {
                if (stoppedIds.Contains(id)) throw new PersonStopped();
                if ((TurnPhase)phase == TurnPhase.Active && identity != id) throw new TurnMismatch();
                identity = id;
                Interlocked.Exchange(ref phase, (int)TurnPhase.Active);
                notice.Show();
            }
        }
        // Status and cleanup bypass activity, but never bypass an existing turn identity.
        internal void Match(string id)
        {
            lock (transitions)
                if ((TurnPhase)phase != TurnPhase.Idle && identity != id) throw new TurnMismatch();
        }
        internal void End()
        { lock (transitions) { Interlocked.CompareExchange(ref phase, (int)TurnPhase.Idle, (int)TurnPhase.Active); notice.Hide(); } }
        internal void Stop()
        {
            // Queue the event under the transition lock: a new begin_turn cannot
            // acknowledge its reset before the prior stopped event has been queued.
            lock (transitions)
            {
                if (Interlocked.CompareExchange(ref phase, (int)TurnPhase.Stopped, (int)TurnPhase.Active) == (int)TurnPhase.Active)
                {
                    stoppedIds.Add(identity);
                    notice.Hide();
                    // A broken stdout cannot unwind through Windows' unmanaged hook callback.
                    // The latch remains stopped even when its notification cannot be delivered.
                    try { stopped(); }
                    catch (Exception) { Console.Error.WriteLine("StopNotificationFailed"); }
                }
            }
        }
        internal void Check()
        {
            TurnPhase current = (TurnPhase)Volatile.Read(ref phase);
            if (current == TurnPhase.Stopped) throw new PersonStopped();
            if (current != TurnPhase.Active) throw new NoActiveTurn();
        }
        internal string Status { get { return ((TurnPhase)Volatile.Read(ref phase)).ToString(); } }
        private IntPtr Keyboard(int code, IntPtr message, IntPtr data)
        {
            if (code >= 0)
            {
                var key = (Native.KeyboardEvent)Marshal.PtrToStructure(data, typeof(Native.KeyboardEvent));
                if ((key.Flags & 0x12) == 0)
                {
                    Activity.Physical(key.Time);
                    if (key.Key == 0x1B && (message.ToInt64() == 0x100 || message.ToInt64() == 0x104)) Stop();
                }
                else Activity.Injected(key.Time);
            }
            return Native.CallNextHookEx(hook, code, message, data);
        }
        // Mouse movement counts as Person activity; injected pointer batches do not.
        private IntPtr Mouse(int code, IntPtr message, IntPtr data)
        {
            if (code >= 0)
            {
                var mouse = (Native.MouseEvent)Marshal.PtrToStructure(data, typeof(Native.MouseEvent));
                if ((mouse.Flags & 3) == 0) Activity.Physical(mouse.Time);
                else Activity.Injected(mouse.Time);
            }
            return Native.CallNextHookEx(mouseHook, code, message, data);
        }
        // Low-level hooks require a living message pump on their installation thread.
        // No application keys are consumed: the Person's Escape still reaches their app.
        private void Pump()
        {
            threadId = Native.GetCurrentThreadId();
            Native.Message message;
            Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
            hook = Native.SetWindowsHookEx(13, callback, Native.GetModuleHandle(null), 0);
            mouseHook = Native.SetWindowsHookEx(14, mouseCallback, Native.GetModuleHandle(null), 0);
            ready.Set();
            if (hook == IntPtr.Zero || mouseHook == IntPtr.Zero)
            { if (hook != IntPtr.Zero) Native.UnhookWindowsHookEx(hook); if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook); return; }
            while (Native.GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                Native.TranslateMessage(ref message);
                Native.DispatchMessage(ref message);
            }
            Native.UnhookWindowsHookEx(hook);
            Native.UnhookWindowsHookEx(mouseHook);
        }
        public void Dispose()
        {
            End();
            Native.PostThreadMessage(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero);
            thread.Join();
            ready.Dispose();
        }
    }
}
