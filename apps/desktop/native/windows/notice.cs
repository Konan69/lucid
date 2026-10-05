namespace Vivid.Windows
{
    // Empty lifecycle seam: the UI owner draws the notice outside this console helper.
    // These calls may originate on the request, keyboard-hook or parent-exit thread.
    internal sealed class Notice
    {
        internal void Show() { }
        internal void Hide() { }
    }
}
