using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Text;

namespace Vivid.Windows
{
    internal static class Closing
    {
        private const uint ObservationMilliseconds = 350;
        // Listen before posting so short-lived dialogs/destruction cannot be missed.
        // Observe only this HWND or its root-owned popups, never a same-process peer.
        internal static object Post(Window window, Budget budget)
        {
            string dialogClass = null;
            var before = new HashSet<IntPtr>();
            Native.EnumWindows(delegate(IntPtr handle, IntPtr state)
            { if (Native.IsWindowVisible(handle) && Native.GetAncestor(handle, 3) == window.Handle) before.Add(handle); return true; }, IntPtr.Zero);
            Native.EventCallback callback = delegate(IntPtr unused, uint kind, IntPtr handle, int objectId, int child, uint thread, uint time)
            {
                if ((kind == 0x8000 || kind == 0x8002) && handle != IntPtr.Zero && !before.Contains(handle) && objectId == 0 && handle != window.Handle &&
                    Native.GetAncestor(handle, 3) == window.Handle && Native.IsWindowVisible(handle))
                    dialogClass = Class(handle);
            };
            IntPtr hook = Native.SetWinEventHook(0x8000, 0x8003, IntPtr.Zero, callback, window.pid, 0, 0);
            if (hook == IntPtr.Zero) throw new NativeInputFailed("close observation could not be installed; no close posted", 0);
            try
            {
                if (!Native.PostMessage(window.Handle, 0x112, new UIntPtr(0xF060), IntPtr.Zero))
                    throw new NativeInputFailed("named window refused the posted close; do not retry automatically", 0);
                var elapsed = Stopwatch.StartNew();
                uint wait = Math.Min(ObservationMilliseconds, budget.Remaining);
                Native.Message message;
                while (elapsed.ElapsedMilliseconds < wait)
                {
                    while (Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 1))
                    { Native.TranslateMessage(ref message); Native.DispatchMessage(ref message); }
                    if (!Native.IsWindow(window.Handle)) return new { outcome = "closed" };
                    FindDialog(window, before, ref dialogClass);
                    if (dialogClass != null) return new { outcome = "closePending", dialogClass = dialogClass };
                    Native.MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, (uint)Math.Max(0, wait - elapsed.ElapsedMilliseconds), 0x4FF, 4);
                }
                budget.Check();
                if (!Native.IsWindow(window.Handle)) return new { outcome = "closed" };
                FindDialog(window, before, ref dialogClass);
                return new { outcome = "closePending", dialogClass = dialogClass };
            }
            finally { Native.UnhookWinEvent(hook); GC.KeepAlive(callback); }
        }
        // Class only: never query a dialog title, text, or accessibility document.
        private static void FindDialog(Window window, HashSet<IntPtr> before, ref string dialogClass)
        {
            string found = null;
            Native.EnumWindows(delegate(IntPtr handle, IntPtr state)
            {
                if (handle != window.Handle && !before.Contains(handle) && Native.IsWindowVisible(handle) && Native.GetAncestor(handle, 3) == window.Handle)
                { found = Class(handle); return false; }
                return true;
            }, IntPtr.Zero);
            if (found != null) dialogClass = found;
        }
        private static string Class(IntPtr handle)
        {
            var name = new StringBuilder(256);
            return Native.GetClassName(handle, name, name.Capacity) == 0 ? null : name.ToString();
        }
    }
}
