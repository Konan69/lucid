using System;
using System.Collections.Generic;
using System.Text;
using System.Windows.Automation;

namespace Vivid.Windows
{
    internal sealed class TextSnapshot
    {
        internal readonly string Text;
        internal readonly List<AutomationElement> Elements;
        internal readonly bool Truncated;
        internal TextSnapshot(string text, List<AutomationElement> elements, bool truncated)
        { Text = text; Elements = elements; Truncated = truncated; }
    }
    // Control-view preorder owns indexes. Stop traversal globally at 500 elements
    // or depth 32, including sibling traversal; cap provider text before serialization.
    internal static class Outline
    {
        internal static TextSnapshot Read(Window window, Budget budget)
        {
            var reader = new Reader(budget);
            try { return reader.Read(AutomationElement.FromHandle(window.Handle)); }
            catch (ElementNotAvailableException)
            { if (!Native.IsWindow(window.Handle)) throw Windows.Gone(); throw new AccessibilityFailed(); }
            catch (InvalidOperationException) { throw new AccessibilityFailed(); }
            catch (System.Runtime.InteropServices.COMException) { throw new AccessibilityFailed(); }
        }
        // Traversal state has one owner, so every ancestor observes the same hard stop.
        private sealed class Reader
        {
            private readonly Budget budget;
            private readonly List<AutomationElement> elements = new List<AutomationElement>();
            private readonly StringBuilder text = new StringBuilder();
            private bool truncated;
            internal Reader(Budget budget) { this.budget = budget; }
            internal TextSnapshot Read(AutomationElement root)
            { Walk(root, 0); return new TextSnapshot(text.ToString(), elements, truncated); }
            private bool Walk(AutomationElement element, int depth)
            {
                budget.Check();
                if (elements.Count >= 500 || depth >= 32) { truncated = true; return false; }
                var current = element.Current;
                int index = elements.Count;
                elements.Add(element);
                var bounds = current.BoundingRectangle;
                string name = Limit(Name(element, current));
                string value = Limit(Value(element, current.IsPassword));
                if (value == "(unbounded value skipped)") truncated = true;
                text.AppendFormat(System.Globalization.CultureInfo.InvariantCulture,
                    "{0} {1}{2} name={3} value={4} enabled={5} bounds=({6},{7},{8},{9})\n",
                    index, new string(' ', depth * 2), current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
                    Quote(name), Quote(value), current.IsEnabled ? "true" : "false",
                    bounds.X, bounds.Y, bounds.Width, bounds.Height);
                if (elements.Count == 500) { truncated = true; return false; }
                var walker = TreeWalker.ControlViewWalker;
                AutomationElement child = walker.GetFirstChild(element);
                while (child != null)
                {
                    if (!Walk(child, depth + 1)) return false;
                    budget.Check(); child = walker.GetNextSibling(child);
                }
                return true;
            }
            // Virtual controls have meaningful UIA names but no HWND caption. Only
            // document-like TextPattern controls substitute bounded provider text: their
            // Name may contain the entire document. All other labels are read and capped.
            private static string Name(AutomationElement element, AutomationElement.AutomationElementInformation current)
            {
                if (current.IsPassword) return "(hidden)";
                object pattern;
                if ((current.ControlType == ControlType.Document || current.ControlType == ControlType.Edit ||
                    current.ControlType == ControlType.Text) && element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                    return ((TextPattern)pattern).DocumentRange.GetText(201);
                return current.Name;
            }
            private string Limit(string value)
            {
                if (value.Length <= 200) return value;
                truncated = true;
                int length = Char.IsHighSurrogate(value[198]) ? 198 : 199;
                return value.Substring(0, length) + "…";
            }
        }
        private static string Quote(string value)
        { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\""; }
        // Password values are never requested. TextPattern is bounded at the provider;
        // one extra character distinguishes a complete 200-character value from truncation.
        private static string Value(AutomationElement element, bool password)
        {
            if (password) return "(hidden)";
            object pattern;
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return ((TextPattern)pattern).DocumentRange.GetText(201);
            // ValuePattern exposes neither a bounded read nor a reported length.
            // Never fetch Current.Value merely to truncate it after allocation.
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return "(unbounded value skipped)";
            return "(no bounded text pattern)";
        }
    }
}
