using System;
using System.Threading;

namespace Vivid.Windows
{
    // The dedicated watchdog also covers blocked response publication. Receipt is
    // completion; merely claiming the reply must not disarm the deadline.
    internal sealed class Deadline : IDisposable
    {
        private int terminal;
        private readonly ManualResetEvent finished = new ManualResetEvent(false);
        private readonly Thread watchdog;
        internal Deadline(int milliseconds, Action expired)
        {
            watchdog = new Thread(delegate() {
                if (finished.WaitOne(milliseconds == 0 ? Timeout.Infinite : milliseconds)) return;
                int claimed = Interlocked.CompareExchange(ref terminal, 3, 0);
                if (claimed == 2) return; // Receipt won the race before its event signal.
                // A claimed normal reply may already be queued: never add a second
                // response for that id. Backpressure still cannot prevent exit 70.
                if (claimed == 0)
                {
                    // Diagnostics may block on stdout/turn lock; only this background
                    // worker waits there, with a maximum 100ms grace before process exit.
                    var reply = new Thread(delegate() { try { expired(); } catch (Exception) { } });
                    reply.IsBackground = true;
                    reply.Start();
                    reply.Join(100);
                }
                Environment.Exit(70);
            });
            watchdog.IsBackground = true;
            watchdog.Start();
        }
        // A serialization/publish failure releases the claim for the named error reply.
        internal void Complete(Action reply)
        {
            if (Interlocked.CompareExchange(ref terminal, 1, 0) != 0) return;
            try { reply(); Interlocked.Exchange(ref terminal, 2); finished.Set(); }
            catch { Interlocked.Exchange(ref terminal, 0); throw; }
        }
        public void Dispose() { finished.Set(); watchdog.Join(); finished.Dispose(); }
    }
}
