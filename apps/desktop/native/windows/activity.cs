using System;
using System.Security.Cryptography;
using System.Threading;

namespace Vivid.Windows
{
    // Every input event the helper sends carries a private tag, and that is all this
    // class is for: the keyboard hook tells the helper's own Escape (typed into an app,
    // not a stop) from the Person's Escape (a stop), and the hook self-test recognises
    // its own probes. The Person using the keyboard or mouse refuses nothing.
    internal static class Activity
    {
        // Private process nonce identifies only our batches, including probes/recovery.
        // Keep the nonce DWORD-sized inside ULONG_PTR: the live mouse path lost a full
        // 64-bit tag, while keyboard and mouse hook receipts both preserve this value.
        // Never log it.
        internal static readonly UIntPtr OwnInputTag = CreateTag();
        private static UIntPtr CreateTag()
        {
            var bytes = new byte[4];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return new UIntPtr(BitConverter.ToUInt32(bytes, 0) | 1U);
        }
        private static long batches;
        // Tag, then send. Returns how many events Windows inserted.
        internal static uint Dispatch(Native.Input[] inputs)
        {
            Stamp(inputs);
            return Native.SendInput((uint)inputs.Length, inputs,
                System.Runtime.InteropServices.Marshal.SizeOf(typeof(Native.Input)));
        }
        // Tag before dispatch because the hook can run before SendInput returns.
        private static void Stamp(Native.Input[] inputs)
        {
            uint time = Native.GetTickCount();
            Interlocked.Increment(ref batches);
            for (int i = 0; i < inputs.Length; i++)
                if (inputs[i].Type == 1) { inputs[i].Data.Keyboard.Time = time; inputs[i].Data.Keyboard.Extra = OwnInputTag; }
                else { inputs[i].Data.Mouse.Time = time; inputs[i].Data.Mouse.Extra = OwnInputTag; }
        }
        // Test-only: how many batches this helper has sent. No key or mouse data is kept.
        internal static object Observe()
        { return new { ownInputBatches = Interlocked.Read(ref batches) }; }
    }
}
