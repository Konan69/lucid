using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Xml;

namespace Vivid.Windows
{
    // The resolved executable is kept private; wire metadata conveys provenance
    // and refusal without giving the caller arbitrary executable launch authority.
    internal abstract class InstalledApp
    {
        public string name { get; private set; }
        public string id { get; private set; }
        public string source { get; private set; }
        public bool launchable { get { return reason == null; } }
        public string reason { get; protected set; }
        internal readonly string Target;
        protected InstalledApp(string name, string id, string source, string target)
        { this.name = name; this.id = id; this.source = source; Target = target; reason = Shells.Reason(target); }
        internal virtual string ResolveTarget() { return Target; }
        internal abstract uint Launch();
    }
    internal sealed class PackagedApp : InstalledApp
    {
        internal readonly string Aumid;
        private readonly string root;
        internal PackagedApp(string name, string aumid, string root, string target) : base(name, "package:" + aumid, "machine", target) { Aumid = aumid; this.root = root; }
        // The broker resolves the AUMID again; re-read the manifest before authorizing it.
        internal override string ResolveTarget() { return Apps.PackageTarget(root, Aumid); }
        internal override uint Launch() { return Apps.Activate(Aumid); }
    }
    // A menu shortcut retains its own provenance even when activation is packaged.
    internal sealed class PackagedShortcutApp : InstalledApp
    {
        private readonly PackagedApp package;
        internal PackagedShortcutApp(string name, string id, string source, PackagedApp package) : base(name, id, source, package.Target) { this.package = package; }
        internal override string ResolveTarget() { return package.ResolveTarget(); }
        internal override uint Launch() { return package.Launch(); }
    }
    internal sealed class ShortcutApp : InstalledApp
    {
        internal readonly string Arguments, Directory;
        internal ShortcutApp(string name, string id, string source, string target, string arguments, string directory) : base(name, id, source, target)
        {
            Arguments = arguments; Directory = directory;
            // Unresolved Explorer arguments may invoke another executable through
            // the shell. Only an explicitly resolved packaged shortcut bypasses this.
            if (String.Equals(Path.GetFileName(target), "explorer.exe", StringComparison.OrdinalIgnoreCase) && !String.IsNullOrWhiteSpace(arguments))
                reason = "AppTargetUnverified";
        }
        internal override uint Launch() { return Apps.Start(this); }
    }
    internal enum InventoryPhase { Unobserved, Observed }
    internal enum MenuLocation { Person, Shared }
    internal sealed class Apps
    {
        private InventoryPhase phase;
        private readonly Dictionary<string, InstalledApp> inventory = new Dictionary<string, InstalledApp>(StringComparer.OrdinalIgnoreCase);
        internal void Clear() { inventory.Clear(); phase = InventoryPhase.Unobserved; }
        // Entry/folder errors have local scope. A budget failure still aborts the
        // request and cannot publish a partially observed catalog as launch authority.
        internal object List(Budget budget)
        {
            var fresh = new Dictionary<string, InstalledApp>(StringComparer.OrdinalIgnoreCase);
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true));
            dynamic links = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
            int skipped = 0;
            try
            {
                Packages(shell, fresh, budget, ref skipped);
                Shortcuts(MenuLocation.Person, links, fresh, budget, ref skipped);
                Shortcuts(MenuLocation.Shared, links, fresh, budget, ref skipped);
            }
            catch (COMException) { throw new AppInventoryFailed(); }
            finally { Marshal.FinalReleaseComObject(links); Marshal.FinalReleaseComObject(shell); }
            inventory.Clear();
            foreach (var pair in fresh) inventory.Add(pair.Key, pair.Value);
            phase = InventoryPhase.Observed;
            var result = new List<InstalledApp>(inventory.Values);
            result.Sort(delegate(InstalledApp a, InstalledApp b) { return StringComparer.OrdinalIgnoreCase.Compare(a.name, b.name); });
            return new { apps = result, skipped = skipped };
        }
        // AppsFolder supplies package location and AUMID; resolve the actual app
        // executable from its manifest rather than trusting a display name or alias.
        private static void Packages(dynamic shell, Dictionary<string, InstalledApp> result, Budget budget, ref int skipped)
        {
            dynamic folder = shell.NameSpace("shell:AppsFolder");
            if (folder == null) throw new AppInventoryFailed();
            dynamic items = null;
            try
            {
                items = folder.Items();
                for (int i = 0; i < items.Count; i++)
                {
                    budget.Check();
                    dynamic item = null;
                    try
                    {
                        item = items.Item(i);
                        if (item == null) { skipped++; continue; }
                        string aumid = Convert.ToString(item.ExtendedProperty("System.AppUserModel.ID"));
                        string package = Convert.ToString(item.ExtendedProperty("System.AppUserModel.PackageInstallPath"));
                        if (String.IsNullOrEmpty(aumid) || String.IsNullOrEmpty(package)) continue;
                        var app = new PackagedApp((string)item.Name, aumid, package, PackageTarget(package, aumid));
                        result[app.id] = app;
                    }
                    catch (COMException) { skipped++; }
                    catch (IOException) { skipped++; }
                    catch (UnauthorizedAccessException) { skipped++; }
                    catch (XmlException) { skipped++; }
                    catch (ArgumentException) { skipped++; }
                    catch (AppTargetUnverified) { skipped++; }
                    finally { if (item != null) Marshal.FinalReleaseComObject(item); }
                }
            }
            finally { if (items != null) Marshal.FinalReleaseComObject(items); Marshal.FinalReleaseComObject(folder); }
        }
        // Disable DTDs and bound manifest input. AUMID's suffix identifies exactly
        // one Application; unresolved web/hosted entries are not launch authority.
        internal static string PackageTarget(string root, string aumid)
        {
            int separator = aumid.LastIndexOf('!');
            if (separator < 0) throw new AppTargetUnverified();
            using (XmlReader reader = XmlReader.Create(Path.Combine(root, "AppxManifest.xml"),
                new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1048576 }))
            {
                while (reader.Read())
                {
                    if (reader.NodeType != XmlNodeType.Element || reader.LocalName != "Application" || reader.GetAttribute("Id") != aumid.Substring(separator + 1)) continue;
                    string executable = reader.GetAttribute("Executable");
                    if (String.IsNullOrWhiteSpace(executable)) throw new AppTargetUnverified();
                    string target = Path.GetFullPath(Path.Combine(root, executable));
                    if (!target.StartsWith(Path.GetFullPath(root) + "\\", StringComparison.OrdinalIgnoreCase)) throw new AppTargetUnverified();
                    return target;
                }
            }
            throw new AppTargetUnverified();
        }
        // Snapshot one directory at a time so an unreadable child doesn't terminate
        // sibling traversal. Missing roots are normal; inaccessible roots count once.
        private static void Shortcuts(MenuLocation location, dynamic links, Dictionary<string, InstalledApp> result, Budget budget, ref int skipped)
        {
            string root = Environment.GetFolderPath(location == MenuLocation.Person ? Environment.SpecialFolder.Programs : Environment.SpecialFolder.CommonPrograms);
            string source = location == MenuLocation.Person ? "person" : "machine";
            if (String.IsNullOrEmpty(root)) return;
            var pending = new Stack<string>();
            pending.Push(root);
            while (pending.Count > 0)
            {
                budget.Check();
                string directory = pending.Pop();
                string[] paths, directories;
                try { paths = System.IO.Directory.GetFiles(directory, "*.lnk"); directories = System.IO.Directory.GetDirectories(directory); }
                catch (DirectoryNotFoundException) { continue; }
                catch (IOException) { skipped++; continue; }
                catch (UnauthorizedAccessException) { skipped++; continue; }
                foreach (string child in directories)
                {
                    try { if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) { skipped++; continue; } pending.Push(child); }
                    catch (IOException) { skipped++; }
                    catch (UnauthorizedAccessException) { skipped++; }
                }
                foreach (string path in paths)
                {
                    budget.Check();
                    ReadShortcut(path, root, source, links, result, ref skipped);
                }
            }
        }
        // A malformed or dangling shortcut is counted, never allowed to poison the
        // rest of the menu. Shell-mediated AppsFolder shortcuts resolve to packages.
        private static void ReadShortcut(string path, string root, string source, dynamic links, Dictionary<string, InstalledApp> result, ref int skipped)
        {
            dynamic link = null;
            try
            {
                link = links.CreateShortcut(path);
                if (link == null) { skipped++; return; }
                string target = Environment.ExpandEnvironmentVariables((string)link.TargetPath);
                string arguments = (string)link.Arguments;
                if (!target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(target)) { skipped++; return; }
                // Explorer command-line activation is indirect and cannot prove a GUI
                // target. Resolve a known AppsFolder AUMID or refuse this launcher.
                string prefix = "shell:AppsFolder\\";
                if (String.Equals(Path.GetFileName(target), "explorer.exe", StringComparison.OrdinalIgnoreCase) && arguments.IndexOf(prefix, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    string aumid = arguments.Substring(arguments.IndexOf(prefix, StringComparison.OrdinalIgnoreCase) + prefix.Length).Trim(' ', '"');
                    InstalledApp package;
                    if (!result.TryGetValue("package:" + aumid, out package)) { skipped++; return; }
                    var packaged = package as PackagedApp;
                    if (packaged == null) { skipped++; return; }
                    var shortcut = new PackagedShortcutApp(Path.GetFileNameWithoutExtension(path),
                        source + ":" + path.Substring(root.Length + 1).Replace('\\', '/'), source, packaged);
                    result[shortcut.id] = shortcut;
                    return;
                }
                var app = new ShortcutApp(Path.GetFileNameWithoutExtension(path),
                    source + ":" + path.Substring(root.Length + 1).Replace('\\', '/'), source, target, arguments, (string)link.WorkingDirectory);
                result[app.id] = app;
            }
            catch (COMException) { skipped++; }
            catch (IOException) { skipped++; }
            catch (UnauthorizedAccessException) { skipped++; }
            catch (ArgumentException) { skipped++; }
            finally { if (link != null) Marshal.FinalReleaseComObject(link); }
        }
        // Recheck the actual executable immediately before launch: mutable per-user
        // entries are provenance, not a guarantee that software is installed/trusted.
        internal object Launch(Fields fields, Budget budget)
        {
            string name = fields.Text("app");
            if (String.IsNullOrWhiteSpace(name) || name != name.Trim() || name.IndexOfAny(new[] { '\\', '/', ':', '"', '\r', '\n', '\0' }) >= 0 || name.Contains(" --")) throw new AppNameRequired();
            if (phase != InventoryPhase.Observed) throw new AppInventoryRequired();
            InstalledApp selected = null;
            foreach (InstalledApp candidate in inventory.Values)
            {
                if (!String.Equals(candidate.name, name, StringComparison.OrdinalIgnoreCase)) continue;
                if (fields.Has("id") && fields.Text("id") != candidate.id) continue;
                if (selected != null) throw new AppNameAmbiguous();
                selected = candidate;
            }
            if (selected == null) throw new AppNotInstalled();
            Shells.Require(selected.reason);
            Shells.Require(Shells.Reason(selected.ResolveTarget()));
            budget.Check();
            uint pid;
            try { pid = selected.Launch(); }
            catch (COMException) { throw new LaunchFailed(); }
            return new { pid = pid, app = selected.name, id = selected.id };
        }
        // ActivateApplication delegates packaged process creation to Windows' broker,
        // without passing helper handles or environment. No ShellExecute child path.
        internal static uint Activate(string aumid)
        {
            var manager = (Native.Activation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
            try { uint pid; int result = manager.ActivateApplication(aumid, null, 2, out pid); if (result < 0 || pid == 0) throw new LaunchFailed(); return pid; }
            finally { Marshal.FinalReleaseComObject(manager); }
        }
        // Fresh Person-session environment excludes desktop/helper secrets; the
        // interactive profile is already loaded. TOKEN_QUERY|TOKEN_DUPLICATE is
        // required for a primary token. No inherited handles or helper console flags.
        // learn.microsoft.com/windows/win32/api/userenv/nf-userenv-createenvironmentblock
        internal static uint Start(ShortcutApp app)
        {
            IntPtr token;
            if (!Native.OpenProcessToken(Native.GetCurrentProcess(), 10, out token)) throw new LaunchFailed();
            try
            {
                IntPtr environment;
                if (!Native.CreateEnvironmentBlock(out environment, token, false)) throw new LaunchFailed();
                try
                {
                    var startup = new Native.Startup { Size = Marshal.SizeOf(typeof(Native.Startup)), Flags = 0x100 };
                    Native.ProcessInformation process;
                    var command = new System.Text.StringBuilder("\"" + app.Target + "\" " + app.Arguments);
                    string directory = String.IsNullOrEmpty(app.Directory) ? Path.GetDirectoryName(app.Target) : app.Directory;
                    if (!Native.CreateProcess(app.Target, command, IntPtr.Zero, IntPtr.Zero, false, 0x400,
                        environment, directory, ref startup, out process)) throw new LaunchFailed();
                    try { return process.Id; }
                    finally { Native.CloseHandle(process.Thread); Native.CloseHandle(process.Process); }
                }
                finally { Native.DestroyEnvironmentBlock(environment); }
            }
            finally { Native.CloseHandle(token); }
        }
    }
}
