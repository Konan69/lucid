using System;
using System.Collections.Generic;
using System.Threading;

namespace Vivid.Windows
{
    internal enum TurnPhase { Idle, Active, Stopped }

    // A stop ends the current turn and revokes its identity for good. Nothing else:
    // there is no pause afterwards, and a new id begins a new turn at once.
    internal sealed class Turn : IDisposable
    {
        private int phase;
        private string identity;
        private readonly HashSet<string> stoppedIds = new HashSet<string>(StringComparer.Ordinal);
        private readonly object transitions = new object();
        private readonly Hooks hooks;
        private readonly Notice notice = new Notice();
        private readonly Action<string, uint> stopped;
        internal Turn(Action<string, uint> stopped)
        { this.stopped = stopped; hooks = new Hooks(Stop); }
        // Never wait for the hook thread under the state lock: its Escape callback
        // also needs this lock. Install before acknowledgement, remove on failure.
        internal void Begin(string id)
        {
            lock (transitions)
            {
                if (stoppedIds.Contains(id)) throw new PersonStopped();
                if ((TurnPhase)phase == TurnPhase.Active)
                { if (identity != id) throw new TurnMismatch(); return; }
                identity = id; Interlocked.Exchange(ref phase, (int)TurnPhase.Active); notice.Show();
            }
            try { hooks.Install(); Check(); }
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
                stoppedIds.Add(identity); notice.Hide();
                // The wire keeps `cooldown_ms` for the desktop's decoder; it is always 0.
                try { stopped(identity, 0); }
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
        // All state-changing input, including UIA patterns, proves both hook receipts:
        // without live hooks the Person's Escape could not stop the turn.
        internal void RequireInput(Budget budget)
        { Check(); if (!hooks.Live(budget)) { Check(); throw new HookUnavailable(); } Check(); budget.Check(); }
        internal object Observe(Budget budget)
        {
            bool live = (TurnPhase)Volatile.Read(ref phase) == TurnPhase.Active && hooks.Live(budget);
            lock (transitions) return new { phase = Status, hooksLive = live, diagnosticsDropped = Diagnostics.Dropped };
        }
        internal void LoseHookForProof() { Check(); hooks.LoseForProof(); }
        internal string Status { get { return ((TurnPhase)Volatile.Read(ref phase)).ToString(); } }
        public void Dispose() { End(); hooks.Dispose(); }
    }
}
