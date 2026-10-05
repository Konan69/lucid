using System;
using System.Collections.Generic;
using System.Threading;

namespace Vivid.Windows
{
    internal enum TurnPhase { Idle, Active, Stopped }

    // Stops revoke the current identity permanently and impose a process-wide quiet
    // cooldown: a new caller id cannot ride over the Person's Escape.
    internal sealed class Turn : IDisposable
    {
        internal const uint StopCooldownMilliseconds = 5000;
        private int phase;
        private string identity;
        private readonly HashSet<string> stoppedIds = new HashSet<string>(StringComparer.Ordinal);
        private readonly object transitions = new object();
        private readonly Hooks hooks;
        private readonly Notice notice = new Notice();
        private readonly Action<string, uint> stopped;
        private bool hasStop;
        private uint stoppedAt;
        internal Turn(Action<string, uint> stopped)
        { this.stopped = stopped; Activity.Initialize(); hooks = new Hooks(Stop); }
        private uint Cooldown()
        {
            if (!hasStop) return 0;
            uint elapsed = unchecked(Native.GetTickCount() - stoppedAt);
            return elapsed < StopCooldownMilliseconds ? StopCooldownMilliseconds - elapsed : 0;
        }
        // Never wait for the hook thread under the state lock: its Escape callback
        // also needs this lock. Install before acknowledgement, remove on failure.
        internal void Begin(string id)
        {
            lock (transitions)
            {
                if (stoppedIds.Contains(id) || Cooldown() != 0) throw new PersonStopped();
                if ((TurnPhase)phase == TurnPhase.Active)
                { if (identity != id) throw new TurnMismatch(); return; }
                identity = id; Interlocked.Exchange(ref phase, (int)TurnPhase.Active); notice.Show();
            }
            try { Activity.Age(); hooks.Install(); Check(); }
            catch { End(); throw; }
        }
        // Reads/cleanup do not require Person idle, but never bypass turn identity.
        internal void Match(string id)
        { lock (transitions) if ((TurnPhase)phase != TurnPhase.Idle && identity != id) throw new TurnMismatch(); }
        internal void End()
        {
            lock (transitions) { Interlocked.CompareExchange(ref phase, (int)TurnPhase.Idle, (int)TurnPhase.Active); notice.Hide(); }
            hooks.Remove();
        }
        // The hook removes itself on its own thread. Queue the turn-bearing event
        // under the transition lock without pipe I/O; no new turn may overtake it.
        internal void Stop()
        {
            lock (transitions)
            {
                if (Interlocked.CompareExchange(ref phase, (int)TurnPhase.Stopped, (int)TurnPhase.Active) != (int)TurnPhase.Active) return;
                stoppedIds.Add(identity); hasStop = true; stoppedAt = Native.GetTickCount(); notice.Hide();
                try { stopped(identity, StopCooldownMilliseconds); }
                catch (Exception) { Diagnostics.Write("StopNotificationFailed"); }
            }
            hooks.Remove();
        }
        internal void Check()
        {
            TurnPhase current = (TurnPhase)Volatile.Read(ref phase);
            if (current == TurnPhase.Stopped) throw new PersonStopped();
            if (current != TurnPhase.Active) throw new NoActiveTurn();
        }
        // All state-changing input, including UIA patterns, proves both hook receipts.
        internal void RequireInput(Budget budget)
        { Check(); if (!hooks.Live(budget)) { Check(); throw new HookUnavailable(); } Check(); budget.Check(); Activity.RequireIdle(); }
        internal object Observe(Budget budget)
        {
            bool live = (TurnPhase)Volatile.Read(ref phase) == TurnPhase.Active && hooks.Live(budget);
            lock (transitions) return new { phase = Status, hooksLive = live, cooldownRemainingMs = Cooldown(), diagnosticsDropped = Diagnostics.Dropped };
        }
        internal void LoseHookForProof() { Check(); hooks.LoseForProof(); }
        internal string Status { get { return ((TurnPhase)Volatile.Read(ref phase)).ToString(); } }
        public void Dispose() { End(); hooks.Dispose(); }
    }
}
