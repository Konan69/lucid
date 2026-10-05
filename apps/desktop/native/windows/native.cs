using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Vivid.Windows
{
    // The ABI layouts are the x64 Windows INPUT, MSG and keyboard-hook contracts.
    // INPUT's union must include MOUSEINPUT's full size even for keyboard events.
    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct LastInput { internal uint Size, Time; }
        [DllImport("user32.dll")] internal static extern bool GetLastInputInfo(ref LastInput input);
        [DllImport("kernel32.dll")] internal static extern uint GetTickCount();
        [StructLayout(LayoutKind.Sequential)] internal struct MouseEvent
        { internal Point Point; internal uint Data, Flags, Time; internal UIntPtr Extra; }
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool AttachThreadInput(uint thread, uint other, bool attach);
        [DllImport("user32.dll")] internal static extern bool BringWindowToTop(IntPtr window);
        [StructLayout(LayoutKind.Sequential)] internal struct GuiThread
        { internal uint Size, Flags; internal IntPtr Active, Focus, Capture, Menu, Move, Caret; internal Rect CaretBounds; }
        [DllImport("user32.dll")] internal static extern bool GetGUIThreadInfo(uint thread, ref GuiThread info);
        internal delegate bool WindowCallback(IntPtr window, IntPtr state);
        internal delegate IntPtr KeyboardCallback(int code, IntPtr message, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] internal struct Rect
        {
            internal int Left, Top, Right, Bottom;
            internal int Width { get { return Right - Left; } }
            internal int Height { get { return Bottom - Top; } }
            internal bool Equals(Rect other)
            { return Left == other.Left && Top == other.Top && Right == other.Right && Bottom == other.Bottom; }
        }
        [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }
        [StructLayout(LayoutKind.Sequential)] internal struct Mouse
        { internal int X, Y; internal uint Data, Flags, Time; internal UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] internal struct Keyboard
        { internal ushort Key, Scan; internal uint Flags, Time; internal UIntPtr Extra; }
        [StructLayout(LayoutKind.Explicit)] internal struct InputUnion
        {
            [FieldOffset(0)] internal Mouse Mouse;
            [FieldOffset(0)] internal Keyboard Keyboard;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct Input
        { internal uint Type; internal InputUnion Data; }
        [StructLayout(LayoutKind.Sequential)] internal struct KeyboardEvent
        { internal uint Key, Scan, Flags, Time; internal UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] internal struct Message
        { internal IntPtr Window; internal uint Id; internal UIntPtr WParam; internal IntPtr LParam; internal uint Time; internal Point Point; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct Startup
        {
            internal int Size; internal string Reserved, Desktop, Title;
            internal uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            internal ushort Show, ReservedSize; internal IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation
        { internal IntPtr Process, Thread; internal uint Id, ThreadId; }
        [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface Activation
        {
            [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id,
                [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint process);
            [PreserveSig] int ActivateForFile(IntPtr id, IntPtr items, IntPtr verb, out uint process);
            [PreserveSig] int ActivateForProtocol(IntPtr id, IntPtr items, out uint process);
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInformation process);
        [DllImport("userenv.dll", SetLastError = true)] internal static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
        [DllImport("userenv.dll")] internal static extern bool DestroyEnvironmentBlock(IntPtr environment);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint count);
        [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
        [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll")] internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
        [DllImport("advapi32.dll")] internal static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")] internal static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr window, StringBuilder name, int count);
        [DllImport("user32.dll")] internal static extern bool EnumWindows(WindowCallback callback, IntPtr state);
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetWindowRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
        [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] internal static extern IntPtr GetDlgItem(IntPtr window, int id);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr CommandLineToArgvW(string command, out int count);
        [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
        internal delegate void EventCallback(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time);
        [DllImport("user32.dll")] internal static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, EventCallback callback, uint process, uint thread, uint flags);
        [DllImport("user32.dll")] internal static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] internal static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr handles, uint timeout, uint mask, uint flags);
        [DllImport("user32.dll")] internal static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll")] internal static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern short VkKeyScanEx(char character, IntPtr layout);
        [DllImport("user32.dll")] internal static extern IntPtr GetKeyboardLayout(uint thread);
        [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool PrintWindow(IntPtr window, IntPtr device, uint flags);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetWindowsHookEx(int kind, KeyboardCallback callback, IntPtr module, uint thread);
        [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll")] internal static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);
        [DllImport("user32.dll")] internal static extern bool PeekMessage(out Message message, IntPtr window, uint minimum, uint maximum, uint remove);
        [DllImport("user32.dll")] internal static extern bool TranslateMessage(ref Message message);
        [DllImport("user32.dll")] internal static extern IntPtr DispatchMessage(ref Message message);
        [DllImport("user32.dll")] internal static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetModuleHandle(string name);
    }
}
