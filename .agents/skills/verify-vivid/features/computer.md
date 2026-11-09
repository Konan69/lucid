# Computer health and recovery

Model requirement. None for this HTTP recipe.

Run `verify feature computer` after Launch and Doctor. The HTTP recipe checks shallow Absent and
Sleeping, unchanged activity, and an idempotent Unsupported restore receipt. Its fixture is a
stopped row with no provider binding in this run's disposable database. It creates no machine.

Recovery receipt persistence, key reuse, ownership and interruption are also exercised against
the real Computer store and fixture Boat HTTP transport by `computers/boat.test.ts`.

The browser recipe (`accessbrowser.mjs` `computerBrowser`) opens Settings, Devices, and checks
the Vivid's computer panel says the health title the server reports (Deep), lists the recovery
ladder 0 to 4 with no button to take a step, and says the same after Check again and after
reload; a Shallow read afterwards must show the Computer unchanged.
Deep Ready and browser restart are blocked. No proof-owned Computer exists. The Boat trial plan
is at its two-machine limit, and the only Vivid Computer is production's. The opt-in health live
proofs require `VIVID_LIVE_COMPUTER_HEALTH=1` and an explicitly named `VIVID_BOAT_MACHINE` other
than `bx_yjj2hakd`. They never create a machine. Do not enable them on the current account.
