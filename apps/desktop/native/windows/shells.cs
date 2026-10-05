using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Vivid.Windows
{
    // One policy owns launch and window refusals. Name rules include GUI terminal
    // hosts; PE inspection also catches renamed console executables and REPLs.
    internal static class Shells
    {
        private static readonly HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "cmd", "powershell", "pwsh", "windowsterminal", "wt", "conhost", "openconsole",
            "wsl", "wslhost", "bash", "mintty", "git-bash", "alacritty", "hyper", "tabby",
            "ssh", "python", "pythonw", "py", "node", "debian", "kali", "pengwin", "fedora",
            "arch", "archlinux", "manjaro", "suse", "sles", "centos", "oraclelinux",
            "putty", "kitty", "ttermpro", "terminal", "zsh", "sh", "fish", "nushell", "nu"
        };
        internal static bool Named(string target)
        {
            string name = Path.GetFileNameWithoutExtension(target).ToLowerInvariant();
            return names.Contains(name) || name.StartsWith("ubuntu") || name.StartsWith("wezterm") ||
                name.StartsWith("opensuse") || name.StartsWith("sles") || name.StartsWith("pengwin") ||
                name.StartsWith("python") || name.StartsWith("fedora") || name.StartsWith("kali") ||
                name.StartsWith("debian") || name.StartsWith("oraclelinux");
        }
        // PE32 and PE32+ share Subsystem offset 68 in the optional header. Only a
        // verified Windows GUI subsystem is launchable; unreadable headers fail closed.
        // learn.microsoft.com/windows/win32/debug/pe-format
        internal static string Reason(string target)
        {
            if (Named(target)) return "ShellRefused";
            try
            {
                using (var stream = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new BinaryReader(stream))
                {
                    if (stream.Length < 64 || reader.ReadUInt16() != 0x5A4D) return "AppTargetUnverified";
                    stream.Position = 0x3C;
                    long header = reader.ReadUInt32();
                    if (header < 64 || header > stream.Length - 94) return "AppTargetUnverified";
                    stream.Position = header;
                    if (reader.ReadUInt32() != 0x4550) return "AppTargetUnverified";
                    stream.Position = header + 20;
                    if (reader.ReadUInt16() < 70) return "AppTargetUnverified";
                    stream.Position = header + 24;
                    ushort magic = reader.ReadUInt16();
                    if (magic != 0x10B && magic != 0x20B) return "AppTargetUnverified";
                    stream.Position = header + 24 + 68;
                    ushort subsystem = reader.ReadUInt16();
                    if (subsystem == 3) return "ShellRefused";
                    return subsystem == 2 ? null : "AppTargetUnverified";
                }
            }
            catch (IOException) { return "AppTargetUnverified"; }
            catch (UnauthorizedAccessException) { return "AppTargetUnverified"; }
            catch (ArgumentException) { return "AppTargetUnverified"; }
        }
        internal static void Require(string reason)
        {
            if (reason == "ShellRefused") throw new ShellRefused();
            if (reason != null) throw new AppTargetUnverified();
        }
        // Reject ALL console windows before touching their text or input. This is
        // deliberately stronger than enumerating attached clients: neither a GUI
        // console client nor a host/client ownership change can bypass the refusal.
        // No AttachConsole call mutates this helper's private stdio connection.
        internal static void Verify(Window window)
        {
            var className = new StringBuilder(256);
            if (Native.GetClassName(window.Handle, className, className.Capacity) == 0) throw Windows.Gone();
            if (className.ToString() == "ConsoleWindowClass" || Named(window.app + ".exe")) throw new ShellRefused();
            if (String.Equals(window.app, "explorer", StringComparison.OrdinalIgnoreCase) &&
                className.ToString() == "#32770" && String.Equals(window.title, "Run", StringComparison.OrdinalIgnoreCase))
                throw new ShellRefused();
            IntPtr process = Native.OpenProcess(0x1000, false, window.pid);
            if (process == IntPtr.Zero) throw new ElevatedTarget();
            try
            {
                var path = new StringBuilder(32768);
                uint length = (uint)path.Capacity;
                if (!Native.QueryFullProcessImageName(process, 0, path, ref length)) throw new ElevatedTarget();
                Require(Reason(path.ToString()));
            }
            finally { Native.CloseHandle(process); }
        }
    }
}
