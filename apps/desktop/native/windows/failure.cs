using System;

namespace Vivid.Windows
{
    // Each refusal has a closed CLR identity and a safe message, never an OS exception
    // string containing application data. Only the request boundary serializes failures.
    internal abstract class Failure : Exception
    {
        protected Failure(string message) : base(message) { }
        internal string Name { get { return GetType().Name; } }
    }
    internal sealed class BadJson : Failure { internal BadJson() : base("request is not valid JSON") { } }
    internal sealed class InvalidRequest : Failure { internal readonly string Field; internal InvalidRequest(string field) : base("invalid or missing field: " + field) { Field = field; } }
    internal sealed class UnknownMethod : Failure { internal UnknownMethod() : base("method is not supported") { } }
    internal sealed class WindowGone : Failure { internal WindowGone() : base("the named window is no longer available") { } }
    internal sealed class PersonActive : Failure { internal PersonActive(uint age) : base("Person input within the last " + Activity.PersonQuietMilliseconds + " ms; ageMs=" + age + "; no activation or input sent") { } }
    internal sealed class HookUnavailable : Failure { internal HookUnavailable() : base("input hook self-test failed; no action sent; end this turn") { } }
    internal sealed class ForegroundRefused : Failure { internal ForegroundRefused(string message) : base(message) { } }
    internal sealed class ScreenshotRequired : Failure { internal ScreenshotRequired() : base("call get_window_state with include_screenshot before issuing coordinate input") { } }
    internal sealed class ScreenshotIdRequired : Failure { internal ScreenshotIdRequired() : base("coordinate input requires screenshotId from the latest screenshot of this window") { } }
    internal sealed class ScreenshotStale : Failure { internal ScreenshotStale(string message) : base(message) { } }
    internal sealed class TextRequired : Failure { internal TextRequired() : base("call get_window_state with include_text before using an accessibility element") { } }
    internal sealed class ElementGone : Failure { internal ElementGone(string message) : base(message) { } }
    internal sealed class InvalidClickCount : Failure { internal InvalidClickCount() : base("click_count must be between 1 and 3") { } }
    internal sealed class RequestBudgetExhausted : Failure { internal RequestBudgetExhausted(string message) : base(message) { } }
    internal sealed class PersonStopped : Failure { internal PersonStopped() : base("stopped by the Person; wait for the " + Turn.StopCooldownMilliseconds + " ms cooldown and use a newly authorized turn id") { } }
    internal sealed class ShellRefused : Failure { internal ShellRefused() : base("shell, terminal or Run dialog refused; no launch, input or capture") { } }
    internal sealed class AppTargetUnverified : Failure { internal AppTargetUnverified() : base("application executable target could not be verified") { } }
    internal sealed class TurnMismatch : Failure { internal TurnMismatch() : base("request turn does not match the current turn") { } }
    internal sealed class NoActiveTurn : Failure { internal NoActiveTurn() : base("send begin_turn before observation or input") { } }
    internal sealed class NativeInputFailed : Failure
    {
        internal readonly uint Inserted;
        internal NativeInputFailed(string message, uint inserted) : base(message) { Inserted = inserted; }
    }
    internal sealed class TypingInterrupted : Failure
    {
        internal readonly int Delivered;
        internal readonly string Reason;
        internal TypingInterrupted(int delivered, Failure reason) : base("typing interrupted; do not retry the whole text")
        { Delivered = delivered; Reason = reason.Name; }
    }
    internal sealed class ScreenshotFailed : Failure { internal ScreenshotFailed(string message) : base(message) { } }
    internal sealed class ScreenshotOccluded : Failure { internal ScreenshotOccluded() : base("screen-copy fallback refused: another window overlaps the named window") { } }
    internal sealed class AccessibilityFailed : Failure { internal AccessibilityFailed() : base("the window provider could not complete this request") { } }
    internal sealed class LaunchFailed : Failure { internal LaunchFailed() : base("Windows could not launch the installed application") { } }
    internal sealed class AppNameRequired : Failure { internal AppNameRequired() : base("launch_app requires an installed application name, without a path or arguments") { } }
    internal sealed class AppInventoryRequired : Failure { internal AppInventoryRequired() : base("call list_apps before launch_app in this turn") { } }
    internal sealed class AppNotInstalled : Failure { internal AppNotInstalled() : base("application name is not in list_apps inventory") { } }
    internal sealed class AppNameAmbiguous : Failure { internal AppNameAmbiguous() : base("application name is ambiguous; supply its list_apps id") { } }
    internal sealed class AppInventoryFailed : Failure { internal AppInventoryFailed() : base("Windows could not enumerate installed applications") { } }
    internal sealed class ModifierHeld : Failure { internal ModifierHeld() : base("a physical modifier is held; no input sent") { } }
    internal sealed class ElevatedTarget : Failure { internal ElevatedTarget() : base("target integrity is higher than the helper or cannot be verified; no input sent") { } }
    internal sealed class HelperElevated : Failure { internal HelperElevated() : base("helper must run unelevated in the Person's own session") { } }
    internal sealed class SystemChordRefused : Failure { internal SystemChordRefused() : base("system chord acts outside the named window; no input sent") { } }
    internal sealed class LineTooLong : Failure { internal LineTooLong() : base("request line exceeds 1 MiB of UTF-8") { } }
    internal sealed class ResponseTooLarge : Failure { internal ResponseTooLarge() : base("response exceeds 32 MiB of UTF-8") { } }
    internal sealed class ProtocolOutputClosed : Failure { internal ProtocolOutputClosed() : base("protocol stdout is closed") { } }
    internal sealed class HelperDefect : Failure { internal HelperDefect() : base("unexpected helper failure; request was not retried") { } }
}
