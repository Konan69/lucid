using System;
using System.Collections.Generic;

namespace Vivid.Windows
{
    // Session last-input time includes SendInput. Explicit batch timestamps identify
    // our injections; physical hooks preserve Person input even in the same millisecond.
    // Microsoft GetLastInputInfo documents nonmonotonic, caller-supplied timestamps.
    internal static class Activity
    {
        internal const uint PersonQuietMilliseconds = 2000;
        private static readonly object gate = new object();
        private static readonly HashSet<uint> injected = new HashSet<uint>();
        private static readonly Queue<uint> stamps = new Queue<uint>();
        private static uint physical, observed;
        private static long physicalEvents, batches, injectedEvents;
        private static uint latestStamp;
        // Seed the physical clock before installing hooks; later OS changes close the startup gap.
        internal static void Initialize()
        {
            uint time = LastInput();
            lock (gate) { physical = time; observed = time; }
        }
        // Failed activity observation refuses global input rather than assuming idle.
        private static uint LastInput()
        {
            var input = new Native.LastInput { Size = 8 };
            if (!Native.GetLastInputInfo(ref input)) throw new NativeInputFailed("session input activity could not be verified", 0);
            return input.Time;
        }
        // Both low-level hooks call this only for noninjected events; no key/mouse data is retained.
        internal static void Physical(uint time)
        {
            lock (gate) { Newest(time); physicalEvents++; }
        }
        // Preserve the most recent physical observation across delayed hook deliveries.
        private static void Newest(uint time)
        {
            uint now = Native.GetTickCount();
            if (unchecked(now - time) < unchecked(now - physical)) physical = time;
        }
        // Reconcile session time with injections while keeping the newest physical hook event.
        internal static uint Age()
        {
            uint last = LastInput();
            lock (gate)
            {
                if (last != observed && !injected.Contains(last)) Newest(last);
                observed = last;
                return unchecked(Native.GetTickCount() - physical);
            }
        }
        // One policy constant governs activation and every pointer/keyboard input batch.
        internal static void RequireIdle()
        {
            uint age = Age();
            if (age < PersonQuietMilliseconds) throw new PersonActive(age);
        }
        // Low-level injected timestamps also identify provider-generated UIA input and
        // Windows-normalized event times. They never erase a physical hook observation.
        internal static void Injected(uint time)
        {
            lock (gate) { Remember(time); Remember(Native.GetTickCount()); injectedEvents++; }
        }
        // Bound distinct timestamps; duplicate batch times must not evict a still-live stamp.
        private static void Remember(uint time)
        {
            if (injected.Add(time)) stamps.Enqueue(time);
            while (stamps.Count > 256) injected.Remove(stamps.Dequeue());
        }
        // Windows can normalize a supplied timestamp. Bracket dispatch with physical
        // hook counters and remember its actual last-input receipt when no Person event
        // intervened. The physical hook's timestamp always remains authoritative.
        internal static uint Dispatch(Native.Input[] inputs)
        {
            long before;
            lock (gate) before = physicalEvents;
            Stamp(inputs);
            uint sent = Native.SendInput((uint)inputs.Length, inputs,
                System.Runtime.InteropServices.Marshal.SizeOf(typeof(Native.Input)));
            uint received;
            try { received = LastInput(); }
            catch (NativeInputFailed) { throw new NativeInputFailed("input activity receipt failed after dispatch; do not retry automatically", sent); }
            lock (gate) if (sent > 0 && before == physicalEvents) Remember(received);
            return sent;
        }
        // Record before dispatch because the hook can run before SendInput returns.
        // Bound bookkeeping independently of typing length; the newest batch is always retained.
        internal static void Stamp(Native.Input[] inputs)
        {
            uint time = Native.GetTickCount();
            if (time == 0) throw new NativeInputFailed("input timestamp unavailable at tick rollover", 0);
            lock (gate)
            {
                Remember(time);
                batches++; latestStamp = time;
            }
            for (int i = 0; i < inputs.Length; i++)
                if (inputs[i].Type == 1) inputs[i].Data.Keyboard.Time = time;
                else inputs[i].Data.Mouse.Time = time;
        }
        // Test-only observation proves idle/injection classification without producing input.
        internal static object Observe()
        {
            uint age = Age();
            lock (gate) return new { physicalAgeMs = age, personActive = age < PersonQuietMilliseconds,
                physicalEvents = physicalEvents, injectedEvents = injectedEvents, ownInputBatches = batches, lastInputTick = LastInput(), latestStampTick = latestStamp };
        }
    }
}
