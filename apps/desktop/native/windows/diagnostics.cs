using System;
using System.Collections.Concurrent;
using System.Threading;

namespace Vivid.Windows
{
    // Diagnostics cannot delay native actions or acknowledgements when stderr is full.
    // Each queued line is bounded; saturation drops diagnostics, never protocol replies.
    internal static class Diagnostics
    {
        private const int Capacity = 256;
        private static readonly BlockingCollection<string> queue = new BlockingCollection<string>(Capacity);
        private static long dropped;
        static Diagnostics()
        {
            var writer = new Thread(Drain);
            writer.IsBackground = true;
            writer.Start();
        }
        internal static long Dropped { get { return Interlocked.Read(ref dropped); } }
        internal static void Write(string line)
        {
            if (line.Length > 1024) line = line.Substring(0, 1024);
            if (!queue.TryAdd(line)) Interlocked.Increment(ref dropped);
        }
        // Only this thread owns stderr. A closed pipe drops remaining diagnostics;
        // a blocked pipe cannot keep the process alive or hold a request thread.
        private static void Drain()
        {
            try { foreach (string line in queue.GetConsumingEnumerable()) Console.Error.WriteLine(line); }
            catch (System.IO.IOException) { while (true) { queue.Take(); Interlocked.Increment(ref dropped); } }
        }
    }
}
