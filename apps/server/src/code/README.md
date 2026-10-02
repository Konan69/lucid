# Program host

Programs require Linux, Node 24 under `/usr`, the systemd user bus reached through
`XDG_RUNTIME_DIR`, `/usr/bin/systemd-run`, `/usr/bin/systemctl`, `/usr/bin/bwrap`,
and `/usr/bin/prlimit`. Bubblewrap must be allowed to create its namespaces. The
user manager needs delegated cgroup v2 `memory`, `cpu`, and `pids` controllers;
otherwise the child memory, CPU and task limits cannot be relied on.

Tests probe these prerequisites and state a skip reason when they are absent.
They use the real interpreter and transient cgroups when the host supports them.
The pipe protocol and JSON result tests need neither systemd nor delegation.

The supervisor uses Node 24's public `stripTypeScriptTypes` compiler once to
prepare trusted worker modules and Code/identity contracts in a unique scoped
directory. Guests mount it read-only at `/vivid/worker`; it is removed when the
supervisor closes. There is no TypeScript loader inherited by the QuickJS worker.
Each program still has a fresh process, VM, namespace and cgroup. Interpreter
startup is charged to the existing program deadline; preparing trusted assets
belongs to supervisor initialization. Generated code carries no product state.

Deployment must ship the Code source directory, the Code and identity contract
sources and installed dependencies at the paths used by the adapter. A server
bundle alone does not supply these worker assets. Alchemy does not yet provision
this Linux host or deployment layout; that remains infrastructure work.
