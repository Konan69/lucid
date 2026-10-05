using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace Vivid.Windows
{
    internal enum Transmission { Sent, Closed }
    // One writer preserves complete JSON lines. Hook notifications enqueue without
    // waiting for stdout, so backpressure cannot make Windows discard the Escape hook.
    // Request publishers wait on their own receipt, including the terminal budget reply.
    internal sealed class Output : IDisposable
    {
        private sealed class Frame
        {
            internal readonly string Line;
            internal readonly TaskCompletionSource<Transmission> Receipt = new TaskCompletionSource<Transmission>();
            internal Frame(string line) { Line = line; }
        }
        private readonly BlockingCollection<Frame> frames = new BlockingCollection<Frame>();
        private readonly Thread writer;
        internal Output()
        { writer = new Thread(Pump); writer.IsBackground = true; writer.Start(); }
        // Only the serialized request thread/watchdog waits for transmission; the
        // keyboard hook must return promptly even when the spawning app stops draining.
        internal void Publish(string line)
        {
            var frame = new Frame(line);
            frames.Add(frame);
            if (frame.Receipt.Task.Result == Transmission.Closed) throw new ProtocolOutputClosed();
        }
        internal void Notify(string line) { frames.Add(new Frame(line)); }
        // A broken pipe closes this transport without an exception escaping a worker
        // thread. Every queued publisher is released with an explicit closed receipt.
        private void Pump()
        {
            Transmission state = Transmission.Sent;
            foreach (Frame frame in frames.GetConsumingEnumerable())
            {
                if (state == Transmission.Sent)
                {
                    try { Console.WriteLine(frame.Line); Console.Out.Flush(); }
                    catch (Exception) { state = Transmission.Closed; }
                }
                frame.Receipt.SetResult(state);
            }
        }
        public void Dispose()
        { frames.CompleteAdding(); writer.Join(); frames.Dispose(); }
    }
}
