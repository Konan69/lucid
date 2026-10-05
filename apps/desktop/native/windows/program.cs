using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Vivid.Windows
{
    internal static class Program
    {
        // Framework-only bootstrap; each request is isolated at Handle. Stdio is private
        // to the spawning desktop main process. Hook notifications enqueue through the dedicated output writer.
        [MTAThread]
        private static int Main(string[] arguments)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            try { using (var output = new Output()) return Serve(arguments, output); }
            catch (Failure error) { Diagnostics.Write(error.Name); return 1; }
            catch (Exception) { Diagnostics.Write("HelperStartupFailed"); return 1; }
        }
        private static int Serve(string[] arguments, Output output)
        {
            Integrity.VerifyHelper();
            if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4)))
            { Diagnostics.Write("DpiAwarenessFailed"); return 1; }
            int parentId = 0;
            bool testMode = false;
            if (!Options(arguments, ref parentId, ref testMode)) return 1;
            using (Process parent = Parent(parentId))
            using (var turn = new Turn(delegate(string id, uint cooldown) { output.Notify(Encode(new { @event = "stopped", turn = id, cooldown_ms = cooldown })); }))
            using (var input = new BufferedStream(Console.OpenStandardInput(), 8192))
            {
                if (parent != null)
                { parent.EnableRaisingEvents = true; parent.Exited += delegate { turn.End(); Environment.Exit(0); }; if (parent.HasExited) return 0; }
                var computer = new Computer(turn, testMode);
                string line; Failure error;
                while (ReadLine(input, out line, out error))
                {
                    if (error != null) { Error(0, error, output); continue; }
                    if (!Handle(line, computer, turn, output)) break;
                }
            }
            return 0;
        }
        // Consume an oversized line through LF without retaining it, then serve the next
        // request. UTF-8 byte limits apply before JSON decoding or unbounded allocation.
        private static bool ReadLine(Stream input, out string line, out Failure error)
        {
            line = null; error = null;
            using (var bytes = new MemoryStream())
            {
                int value; bool over = false;
                while ((value = input.ReadByte()) >= 0 && value != 10)
                {
                    if (bytes.Length >= 1048576) over = true;
                    if (!over) bytes.WriteByte((byte)value);
                }
                if (value < 0 && bytes.Length == 0 && !over) return false;
                if (over) { error = new LineTooLong(); return true; }
                try { line = new UTF8Encoding(false, true).GetString(bytes.ToArray()).TrimEnd('\r'); }
                catch (DecoderFallbackException) { error = new BadJson(); }
                return true;
            }
        }
        private static bool Options(string[] arguments, ref int parent, ref bool testMode)
        {
            for (int i = 0; i < arguments.Length; i++)
            {
                if (arguments[i] == "--test-mode") { testMode = true; continue; }
                if (arguments[i] == "--parent-pid" && i + 1 < arguments.Length && Int32.TryParse(arguments[++i], out parent) && parent > 0) continue;
                Diagnostics.Write("InvalidHelperOptions"); return false;
            }
            return true;
        }
        private static Process Parent(int id)
        {
            if (id == 0) return null;
            try { return Process.GetProcessById(id); }
            catch (ArgumentException) { Environment.Exit(0); return null; }
        }
        // Catch every recoverable request exception; only closed, safe errors go onto
        // stdout. Adapter failures are classified by the owning operation, never by text.
        private static bool Handle(string line, Computer computer, Turn turn, Output output)
        {
            int id = 0;
            string method = "unparsed";
            Deadline deadline = null;
            try
            {
                var serializer = Serializer();
                object decoded;
                try { decoded = serializer.DeserializeObject(line); }
                catch (ArgumentException) { throw new BadJson(); }
                catch (InvalidOperationException) { throw new BadJson(); }
                var fields = decoded as System.Collections.Generic.Dictionary<string, object>;
                if (fields != null && fields.ContainsKey("id") && fields["id"] is int) id = (int)fields["id"];
                if (fields == null) throw Fields.Invalid("request");
                Request request = Request.Parse(new Fields(fields));
                method = request.Method;
                if (method == "close") { turn.Match(request.Turn); Write(new { id = id, ok = true, result = new { } }, output); return false; }
                System.Threading.Interlocked.Exchange(ref computer.TypingDelivered, 0);
                deadline = new Deadline(request.Budget, delegate {
                    turn.End();
                    var failure = new RequestBudgetExhausted("request budget exhausted; helper exits; input outcome may be uncertain");
                    if (method == "type_text") Error(id, new TypingInterrupted(System.Threading.Volatile.Read(ref computer.TypingDelivered), failure), output);
                    else Error(id, failure, output);
                });
                var budget = new Budget(request.Budget);
                object result = computer.Execute(request, budget);
                budget.Check();
                string reply = Encode(new { id = id, ok = true, result = result });
                deadline.Complete(delegate { output.Publish(reply); });
            }
            catch (Failure error) { ReplyError(deadline, id, error, output); }
            catch (System.Windows.Automation.ElementNotAvailableException) { ReplyError(deadline, id, Windows.Gone(), output); }
            catch (System.Windows.Automation.ElementNotEnabledException) { ReplyError(deadline, id, new ElementGone("the accessibility element is disabled"), output); }
            catch (Exception) { ReplyError(deadline, id, Classify(method), output); }
            finally { if (deadline != null) deadline.Dispose(); }
            return true;
        }
        private static Failure Classify(string method)
        {
            switch (method)
            {
                case "list_apps": return new AppInventoryFailed();
                case "launch_app": return new LaunchFailed();
                case "click": case "press_key": case "scroll": case "type_text": case "activate_window":
                    return new NativeInputFailed("Windows refused the native operation; do not retry automatically", 0);
                default: return new HelperDefect();
            }
        }
        private static void ReplyError(Deadline deadline, int id, Failure error, Output output)
        {
            if (deadline == null) { Error(id, error, output); return; }
            deadline.Complete(delegate { Error(id, error, output); });
        }
        private static void Error(int id, Failure error, Output output)
        {
            var invalid = error as InvalidRequest;
            if (invalid != null)
            { Write(new { id = id, error = new { name = error.Name, message = error.Message, field = invalid.Field } }, output); return; }
            var typing = error as TypingInterrupted;
            if (typing != null)
            { Write(new { id = id, error = new { name = error.Name, message = error.Message, delivered = typing.Delivered, reason = typing.Reason } }, output); return; }
            Write(new { id = id, error = new { name = error.Name, message = error.Message } }, output);
        }
        private static JavaScriptSerializer Serializer()
        { return new JavaScriptSerializer { MaxJsonLength = 33554432, RecursionLimit = 64 }; }
        // Serialization completes before publishing any bytes; event/response lines cannot
        // interleave. The explicit byte cap also covers app inventories and outline text.
        private static void Write(object value, Output output) { output.Publish(Encode(value)); }
        private static string Encode(object value)
        {
            // The serializer's character ceiling must not preempt our named UTF-8 size error.
            var serializer = Serializer();
            serializer.MaxJsonLength = Int32.MaxValue;
            string line = serializer.Serialize(value);
            if (Encoding.UTF8.GetByteCount(line) > 33554432) throw new ResponseTooLarge();
            return line;
        }
    }
}
