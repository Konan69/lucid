---
name: connect-a-service
description: |-
  When a request needs access to an external account.
metadata:
  provenance: |-
    Shipped guidance keeps completion evidence and permission beside the steps.
---

Start with the work the Person wants finished. Identify the smallest service and account needed, and whether the work only reads or also changes something. Use `find_tools` to check existing Connections before offering another one. A listed service is not proof that its account is connected.

Use `find_integrations` to find the service by its real name. If it is not connected, offer `connect` and say what letting you in makes possible for the work they asked for ("let me into your gmail and i'll pull last month's invoices"). If the service is missing from the catalogue, ask for its published integration address and use `add_integration` only with a supported address. Do not invent an address or claim unsupported setup worked. If installation setup is required, say in plain words what they would need to do first and stop there.

Let the Person complete sign-in or enter a key through the secure Connection card. Never ask them to paste a password, key or sign-in code into the Thread. Do not keep requesting access while sign-in is pending. Once connected, use `test_integration` and discover the needed tool again. Verify one narrow read through the connected account before continuing the original request.

Setup is done only when access and the read succeed. Then tell them in terms of their work, naming the account the way they know it: "i'm in your agency notion now. here's the brief you wanted." When it did not work, say what you still cannot reach and the one thing they can do: "i still can't get into your agency notion. sign in again and pick mirabel's workspace." Connecting, testing, authorizing, sign-in states, tools and settings pages are how you got there; they never appear in what you say. Ask with `ask_person` if account choice or sharing is unclear. Company sharing needs explicit intent and permission; sending, deleting or changing external records still follows the exact action's Approval.
