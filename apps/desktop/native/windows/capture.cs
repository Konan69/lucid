using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Vivid.Windows
{
    internal sealed class Picture
    {
        public string id { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public string png { get; set; }
        public string source { get; set; }
        public double scale { get; set; }
    }
    internal sealed class PictureSnapshot
    {
        internal readonly string Id;
        internal readonly Native.Rect Rectangle;
        internal readonly int Width, Height;
        internal PictureSnapshot(string id, Native.Rect rectangle, int width, int height)
        { Id = id; Rectangle = rectangle; Width = width; Height = height; }
    }
    internal static class Capture
    {
        // Per-monitor V2 makes GetWindowRect, UIA bounds, bitmap pixels and pointer
        // coordinates physical pixels. Encoding downscales the bitmap, never the capture.
        internal static Picture Take(Window window, Budget budget)
        {
            try { return Read(window, budget); }
            catch (ExternalException) { throw new ScreenshotFailed("Windows could not capture the named window"); }
            catch (ArgumentException) { throw new ScreenshotFailed("Windows could not allocate the window screenshot"); }
            catch (InvalidOperationException) { throw new ScreenshotFailed("Windows could not encode the window screenshot"); }
        }
        private static Picture Read(Window window, Budget budget)
        {
            Native.Rect rect = Windows.Rectangle(window);
            if (rect.Width > 8192 || rect.Height > 8192)
                throw new ScreenshotFailed("window screenshot exceeds 8192 pixels on an axis");
            using (var bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb))
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                IntPtr device = graphics.GetHdc();
                bool printed;
                try { printed = Native.PrintWindow(window.Handle, device, 2); }
                finally { graphics.ReleaseHdc(device); }
                string source = "PrintWindow";
                if (!printed || IsBlack(bitmap, budget))
                {
                    VerifyUnoccluded(window, rect);
                    graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(rect.Width, rect.Height), CopyPixelOperation.SourceCopy);
                    source = "screen copy";
                }
                budget.Check();
                return Encode(bitmap, source, budget);
            }
        }
        // LockBits scans packed rows, avoiding millions of GetPixel interop calls at 4K.
        // Alpha is ignored because PrintWindow providers differ in alpha initialization.
        private static bool IsBlack(Bitmap bitmap, Budget budget)
        {
            BitmapData data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var row = new byte[bitmap.Width * 4];
                for (int y = 0; y < bitmap.Height; y++)
                {
                    budget.Check(); Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                    for (int x = 0; x < row.Length; x += 4)
                        if (row[x] != 0 || row[x + 1] != 0 || row[x + 2] != 0) return false;
                }
                return true;
            }
            finally { bitmap.UnlockBits(data); }
        }
        // The picture authority stores both dimensions so integer rounding on the short
        // axis is mapped exactly by Computer. PNG output cannot exceed 1920 on either axis.
        private static Picture Encode(Bitmap original, string source, Budget budget)
        {
            double scale = Math.Min(1.0, 1920.0 / Math.Max(original.Width, original.Height));
            int width = Math.Max(1, (int)Math.Round(original.Width * scale));
            int height = Math.Max(1, (int)Math.Round(original.Height * scale));
            using (var resized = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(resized))
            using (var stream = new MemoryStream())
            {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(original, new Rectangle(0, 0, width, height));
                budget.Check(); resized.Save(stream, ImageFormat.Png); budget.Check();
                return new Picture { id = Guid.NewGuid().ToString("N"), width = width, height = height,
                    png = Convert.ToBase64String(stream.ToArray()), source = source, scale = scale };
            }
        }
        // Screen-copy fallback must never include an unrelated overlapping window.
        // EnumWindows is in front-to-back order; stop checking at the target itself.
        private static void VerifyUnoccluded(Window window, Native.Rect target)
        {
            Windows.Foreground(window);
            if (target.Left < 0 || target.Top < 0 || target.Right > Native.GetSystemMetrics(0) || target.Bottom > Native.GetSystemMetrics(1))
                throw new ScreenshotFailed("screen-copy fallback is limited to a window inside the primary display");
            bool blocked = false;
            Native.EnumWindows(delegate(IntPtr handle, IntPtr unused)
            {
                if (handle == window.Handle) return false;
                Native.Rect other;
                if (!Native.IsWindowVisible(handle) || Native.IsIconic(handle) || !Native.GetWindowRect(handle, out other)) return true;
                if (other.Left < target.Right && other.Right > target.Left && other.Top < target.Bottom && other.Bottom > target.Top)
                { blocked = true; return false; }
                return true;
            }, IntPtr.Zero);
            if (blocked) throw new ScreenshotOccluded();
        }
    }
}
