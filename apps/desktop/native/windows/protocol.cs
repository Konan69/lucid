using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Vivid.Windows
{
    // Parsing owns untyped JSON. Parameters are consumed through these strict accessors;
    // numeric strings, non-finite numbers and absent required fields are not coerced.
    internal sealed class Fields
    {
        private readonly Dictionary<string, object> values;
        internal Fields(Dictionary<string, object> values) { this.values = values; }
        internal bool Has(string key) { return values.ContainsKey(key); }
        internal string Text(string key)
        {
            object value;
            if (!values.TryGetValue(key, out value) || !(value is string)) throw Invalid(key);
            return (string)value;
        }
        internal int Integer(string key)
        {
            long value = Long(key);
            if (value < Int32.MinValue || value > Int32.MaxValue) throw Invalid(key);
            return (int)value;
        }
        internal long Long(string key)
        {
            object value;
            if (!values.TryGetValue(key, out value)) throw Invalid(key);
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            throw Invalid(key);
        }
        internal bool Flag(string key, bool whenAbsent)
        {
            object value;
            if (!values.TryGetValue(key, out value)) return whenAbsent;
            if (!(value is bool)) throw Invalid(key);
            return (bool)value;
        }
        internal Fields Object(string key)
        {
            object value;
            if (!values.TryGetValue(key, out value) || !(value is Dictionary<string, object>)) throw Invalid(key);
            return new Fields((Dictionary<string, object>)value);
        }
        internal static Failure Invalid(string field)
        { return new InvalidRequest(field); }
    }

    internal sealed class Request
    {
        internal readonly int Id;
        internal readonly string Method;
        internal readonly Fields Parameters;
        internal readonly int Budget;
        internal readonly string Turn;
        private Request(int id, string method, Fields parameters, int budget, string turn)
        { Id = id; Method = method; Parameters = parameters; Budget = budget; Turn = turn; }

        // A fresh monotonic budget belongs to each request, never to an entire turn.
        internal static Request Parse(Fields fields)
        {
            string method = fields.Text("method");
            int maximum = method == "launch_app" ? 15000 : 10000;
            int budget = fields.Has("budget_ms") ? fields.Integer("budget_ms") : maximum;
            if (budget < 0 || budget > maximum) throw Fields.Invalid("budget_ms");
            string turn = fields.Has("turn") ? fields.Text("turn") : null;
            if (turn != null && (String.IsNullOrWhiteSpace(turn) || turn.Length > 128)) throw Fields.Invalid("turn");
            if (turn == null && method != "status" && method != "close") throw Fields.Invalid("turn");
            return new Request(fields.Integer("id"), method, fields.Object("params"), budget, turn);
        }
    }

    internal sealed class Budget
    {
        private readonly Stopwatch elapsed = Stopwatch.StartNew();
        private readonly int milliseconds;
        internal Budget(int milliseconds) { this.milliseconds = milliseconds; }
        internal uint Remaining { get { Check(); return (uint)(milliseconds - elapsed.ElapsedMilliseconds); } }
        internal void Check()
        {
            if (elapsed.ElapsedMilliseconds >= milliseconds)
                throw new RequestBudgetExhausted("request budget exhausted");
        }
    }
}
