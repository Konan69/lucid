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
            "powershell_ise", "wscript", "cscript", "mshta", "rundll32", "regsvr32",
            "msiexec", "regedit", "mmc", "control", "cmd", "powershell", "pwsh", "windowsterminal", "wt", "conhost", "openconsole",
            "wsl", "wslhost", "bash", "mintty", "git-bash", "alacritty", "hyper", "tabby",
            "ssh", "python", "pythonw", "py", "node", "debian", "kali", "pengwin", "fedora",
            "arch", "archlinux", "manjaro", "suse", "sles", "centos", "oraclelinux",
            "putty", "kitty", "ttermpro", "terminal", "zsh", "sh", "fish", "nushell", "nu"
        };
        private static readonly HashSet<string> scripts = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".cmd", ".bat", ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".reg", ".msi", ".msp", ".msc"
        };
        // Native argv parsing preserves quoted paths. Arguments resolving to script
        // files/hosts or nested links are refused before Explorer/package remapping.
        internal static string ShortcutReason(string target, string arguments)
        { return ShortcutReason(target, arguments, new HashSet<string>(StringComparer.OrdinalIgnoreCase)); }
        private static string ShortcutReason(string target, string arguments, HashSet<string> visited)
        {
            string reason = LinkReason(target, visited);
            if (reason == "ShellRefused") return reason;
            int count;
            IntPtr argv = Native.CommandLineToArgvW("vivid.exe " + arguments, out count);
            if (argv == IntPtr.Zero) return "AppTargetUnverified";
            try
            {
                for (int i = 1; i < count; i++)
                {
                    string token = Environment.ExpandEnvironmentVariables(Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)));
                    int separator = token.IndexOf('=');
                    if (separator >= 0) token = token.Substring(separator + 1);
                    if (token.StartsWith("/") || token.StartsWith("-"))
                    { separator = token.IndexOf(':'); if (separator >= 0) token = token.Substring(separator + 1); }
                    token = token.Trim('"');
                    string argumentReason = Named(token) || scripts.Contains(Path.GetExtension(token)) ? "ShellRefused" : null;
                    if (Path.GetExtension(token).Equals(".lnk", StringComparison.OrdinalIgnoreCase)) argumentReason = LinkReason(token, visited);
                    if (argumentReason == "ShellRefused") return argumentReason;
                    if (Path.GetExtension(token).Equals(".lnk", StringComparison.OrdinalIgnoreCase) && argumentReason != null)
                        reason = "AppTargetUnverified";
                }
                return reason;
            }
            finally { Native.LocalFree(argv); }
        }
        // Nested shortcut traversal is read-only, depth/cycle bounded and never runs
        // the shell association. A GUI target hidden behind a link is unverified;
        // refused hosts/scripts retain ShellRefused even when their file is absent.
        private static string LinkReason(string target, HashSet<string> visited)
        {
            if (Named(target) || scripts.Contains(Path.GetExtension(target))) return "ShellRefused";
            if (!Path.GetExtension(target).Equals(".lnk", StringComparison.OrdinalIgnoreCase)) return Reason(target);
            if (visited.Count >= 8 || !visited.Add(Path.GetFullPath(target)) || !File.Exists(target)) return "AppTargetUnverified";
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
            dynamic link = null;
            try
            {
                link = shell.CreateShortcut(target);
                string reason = ShortcutReason(Environment.ExpandEnvironmentVariables((string)link.TargetPath), (string)link.Arguments, visited);
                return reason == "ShellRefused" ? reason : "AppTargetUnverified";
            }
            catch (COMException) { return "AppTargetUnverified"; }
            finally { if (link != null) Marshal.FinalReleaseComObject(link); Marshal.FinalReleaseComObject(shell); }
        }
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
            if (Named(target) || scripts.Contains(Path.GetExtension(target))) return "ShellRefused";
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
            catch (NotSupportedException) { return "AppTargetUnverified"; }
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
                className.ToString() == "#32770" && IsRun(window.Handle))
                throw new ShellRefused();
            VerifyProcess(window.pid);
        }
        // Run uses resource control ID 12298, independent of translated caption.
        // ReactOS shell32/shresdef.h IDC_RUNDLG_EDITPATH and dialogs.cpp RunDlgProc
        // reproduce this shell resource contract; only explorer #32770 is considered.
        private static bool IsRun(IntPtr window)
        {
            IntPtr combo = Native.GetDlgItem(window, 12298);
            var name = new StringBuilder(256);
            return combo != IntPtr.Zero && Native.GetClassName(combo, name, name.Capacity) != 0 &&
                String.Equals(name.ToString(), "ComboBox", StringComparison.OrdinalIgnoreCase);
        }
        internal static void VerifyProcess(uint id)
        {
            IntPtr process = Native.OpenProcess(0x1000, false, id);
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
