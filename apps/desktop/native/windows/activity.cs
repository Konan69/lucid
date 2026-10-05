using System;
using System.Collections.Generic;
using System.Security.Cryptography;

namespace Vivid.Windows
{
    // Session last-input time includes SendInput. Explicit batch timestamps identify
    // our injections; person hooks preserve Person input even in the same millisecond.
    // Microsoft GetLastInputInfo documents nonmonotonic, caller-supplied timestamps.
    internal static class Activity
    {
        internal const uint PersonQuietMilliseconds = 2000;
        // Private process nonce identifies only our batches, including probes/recovery.
        // Injected events from every other process remain Person input. Keep the nonce
        // DWORD-sized inside ULONG_PTR: the live mouse path lost a full 64-bit tag,
        // while keyboard and mouse hook receipts both preserve this value. Never log it.
        internal static readonly UIntPtr OwnInputTag = CreateTag();
        private static UIntPtr CreateTag()
        {
            var bytes = new byte[4];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return new UIntPtr(BitConverter.ToUInt32(bytes, 0) | 1U);
        }
        private static readonly object gate = new object();
        private static readonly HashSet<uint> injected = new HashSet<uint>();
        private static readonly Queue<uint> stamps = new Queue<uint>();
        private static uint person, observed;
        private static long personEvents, batches, injectedEvents;
        private static uint latestStamp;
        // Seed the person clock before installing hooks; later OS changes close the startup gap.
        internal static void Initialize()
        {
            uint time = LastInput();
            lock (gate) { person = time; observed = time; }
        }
        // Failed activity observation refuses global input rather than assuming idle.
        private static uint LastInput()
        {
            var input = new Native.LastInput { Size = 8 };
            if (!Native.GetLastInputInfo(ref input)) throw new NativeInputFailed("session input activity could not be verified", 0);
            return input.Time;
        }
        // Both hooks count all events except those carrying our private nonce; no key/mouse data is retained.
        internal static void Person()
        {
            // An injector controls its event timestamp. Receipt time is authoritative
            // for foreign input, so an old/future Time cannot bypass PersonActive.
            lock (gate) { person = Native.GetTickCount(); personEvents++; }
        }
        // Preserve the most recent person observation across delayed hook deliveries.
        private static void Newest(uint time)
        {
            uint now = Native.GetTickCount();
            if (unchecked(now - time) < unchecked(now - person)) person = time;
        }
        // Reconcile session time with injections while keeping the newest person hook event.
        internal static uint Age()
        {
            uint last = LastInput();
            lock (gate)
            {
                if (last != observed && !injected.Contains(last)) Newest(last);
                observed = last;
                return unchecked(Native.GetTickCount() - person);
            }
        }
        // One policy constant governs activation and every pointer/keyboard input batch.
        internal static void RequireIdle()
        {
            uint age = Age();
            if (age < PersonQuietMilliseconds) throw new PersonActive(age);
        }
        // Only nonce-verified helper events reach this path. Provider/remote injections
        // take the Person path, even when Windows sets their injected flags.
        internal static void Own(uint time)
        {
            lock (gate) { Remember(time); Remember(Native.GetTickCount()); injectedEvents++; }
        }
        // Bound distinct timestamps; duplicate batch times must not evict a still-live stamp.
        private static void Remember(uint time)
        {
            if (injected.Add(time)) stamps.Enqueue(time);
            while (stamps.Count > 256) injected.Remove(stamps.Dequeue());
        }
        // Windows can normalize a supplied timestamp. Bracket dispatch with person
        // hook counters and remember its actual last-input receipt when no Person event
        // intervened. The person hook's timestamp always remains authoritative.
        internal static uint Dispatch(Native.Input[] inputs)
        {
            long before;
            lock (gate) before = personEvents;
            Stamp(inputs);
            uint sent = Native.SendInput((uint)inputs.Length, inputs,
                System.Runtime.InteropServices.Marshal.SizeOf(typeof(Native.Input)));
            uint received;
            try { received = LastInput(); }
            catch (NativeInputFailed) { throw new NativeInputFailed("input activity receipt failed after dispatch; do not retry automatically", sent); }
            lock (gate) if (sent > 0 && before == personEvents) Remember(received);
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
                if (inputs[i].Type == 1) { inputs[i].Data.Keyboard.Time = time; inputs[i].Data.Keyboard.Extra = OwnInputTag; }
                else { inputs[i].Data.Mouse.Time = time; inputs[i].Data.Mouse.Extra = OwnInputTag; }
        }
        // Test-only observation proves idle/injection classification without producing input.
        internal static object Observe()
        {
            uint age = Age();
            lock (gate) return new { personAgeMs = age, personActive = age < PersonQuietMilliseconds,
                personEvents = personEvents, injectedEvents = injectedEvents, ownInputBatches = batches, lastInputTick = LastInput(), latestStampTick = latestStamp };
        }
    }
}
