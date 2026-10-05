using System;
using System.Runtime.InteropServices;

namespace Vivid.Windows
{
    // TokenIntegrityLevel is TOKEN_MANDATORY_LABEL: its first field is a SID pointer.
    // Compare the final SID RID, not elevation flags; inaccessible tokens fail closed.
    // devblogs.microsoft.com/oldnewthing/20221017-00/?p=107291
    internal enum TargetAccess { Allowed, Elevated, Unverified }
    internal static class Integrity
    {
        internal static void VerifyHelper()
        {
            int own = Read(Native.GetCurrentProcess());
            if (own < 0 || own > 0x2000) throw new HelperElevated();
        }
        internal static void Verify(Window window)
        {
            uint id;
            Native.GetWindowThreadProcessId(window.Handle, out id);
            if (id != window.pid) throw Windows.Gone();
            if (ForProcess(id) != TargetAccess.Allowed) throw new ElevatedTarget();
        }
        // Inventory reports permission without activating/capturing the target. Input
        // re-reads this token immediately before dispatch, never trusting cached authority.
        internal static TargetAccess ForProcess(uint id)
        {
            IntPtr process = Native.OpenProcess(0x1000, false, id);
            if (process == IntPtr.Zero) return TargetAccess.Unverified;
            try
            {
                int target = Read(process), own = Read(Native.GetCurrentProcess());
                if (target < 0 || own < 0) return TargetAccess.Unverified;
                return target > own ? TargetAccess.Elevated : TargetAccess.Allowed;
            }
            finally { Native.CloseHandle(process); }
        }
        // Bound the token buffer and release both allocations; the final SID subauthority is its integrity RID.
        private static int Read(IntPtr process)
        {
            IntPtr token;
            if (!Native.OpenProcessToken(process, 8, out token)) return -1;
            try
            {
                int size;
                Native.GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
                if (size < IntPtr.Size || size > 65536) return -1;
                IntPtr data = Marshal.AllocHGlobal(size);
                try
                {
                    if (!Native.GetTokenInformation(token, 25, data, size, out size)) return -1;
                    IntPtr sid = Marshal.ReadIntPtr(data);
                    byte count = Marshal.ReadByte(Native.GetSidSubAuthorityCount(sid));
                    return count == 0 ? -1 : Marshal.ReadInt32(Native.GetSidSubAuthority(sid, (uint)count - 1));
                }
                finally { Marshal.FreeHGlobal(data); }
            }
            finally { Native.CloseHandle(token); }
        }
    }
}
