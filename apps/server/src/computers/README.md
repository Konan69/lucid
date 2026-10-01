# Computer local provider

`Machine` owns Docker lifecycle, commands, browser steps and private screen authority. `computerStoreLayer` owns the Person's Computer and approvals; `computerHandlers` expose Vivid's calls. `computerScreenRoutes` authenticates HTTP assets and WebSocket upgrades with the session cookie and proxies only that Person's machine.

Configure the server:

```dotenv
VIVID_COMPUTER_PROVIDER=docker
VIVID_COMPUTER_IMAGE=vivid-computer:local
```

Build with `docker build --tag vivid-computer:local infra/computer`. Docker must be available to the server. No provider configured means `Unavailable`.

Each Computer has its own bridge network with inter-container communication disabled, a durable home volume, and a loopback-only noVNC port. A random 256-bit credential rotates on every container start. It travels on stdin to a mode-0600 tmpfs file, stays redacted in provider memory, and is supplied only by the server proxy's Authorization header. Both direct HTTP access and direct WebSocket upgrades require it. Credentials never enter screen URLs or client responses. A server restart can recover provider authority from the container's tmpfs state. The Docker daemon and installation administrator remain trusted.

Shell source and browser step JSON travel on stdin, absent from host process argv and Docker exec metadata. A process spawn failure is definite; a transport failure or client deadline after spawn produces `MachineExecutionUnknown` and must not be retried automatically. In-container timeouts bound execution without stopping the desktop. Running facts are cached for actions, invalidated on failure or lifecycle change; plain `GetComputer` still reconciles with Docker.

Browser keys permit navigation/editing keys, a printable character, Shift plus a printable character, Control plus A/C/V/F, and Control+Shift+V. Window/tab closing shortcuts are refused. Chromium’s [background keep-alive switch](https://chromium.googlesource.com/chromium/src/+/e570b3f73e37209ce84c2443f9e2e9976d172cba/chrome/browser/background/background_mode_manager.cc) preserves CDP when the last window closes; the driver then creates a page. Explicit stop still closes Chromium and flushes the profile. The driver retains the newest 50 screenshots.

The namespace firewall blocks private, loopback, link-local and reserved IPv4 destinations, permits public IPv4, and drops IPv6. Only the internal desktop/CDP loopback ports and queries to Docker’s embedded DNS resolver are excepted. Public proxies/tunnels remain public destinations: this is address isolation, not application-level filtering.

Accepted limits of this local provider:

- The home volume has no quota.
- The shell and browser share one uid, so a command can read the browser profile and in-container provider state.
- Chromium runs without its own sandbox inside the container. The non-root user, read-only root, dropped capabilities, no-new-privileges, resource limits and network guard form the installation boundary.

Tests opt in with `VIVID_TEST_DOCKER=1`. Store and authenticated screen tests additionally require `VIVID_TEST_DATABASE_URL=postgres://vivid:vivid@127.0.0.1:55440/vivid_test`. They clean up their exact container, network and home-volume names.
