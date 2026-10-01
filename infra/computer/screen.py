"""Authenticate both noVNC assets and upgrades without credentials in argv or URLs."""
import hmac
from pathlib import Path
from websockify.auth_plugins import AuthenticationError


class ScreenAuth:
    """A per-start tmpfs credential is checked in constant time; failures disclose no input."""

    def __init__(self, src):
        """Snapshot the credential for this start; HTTP requests never read home or process arguments."""
        self.authorization = Path(src).read_text(encoding="ascii")

    def authenticate(self, headers, target_host, target_port):
        """Only server-side screen authority permits assets and keyboard/pointer upgrades."""
        supplied = headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode("utf-8"), self.authorization.encode("ascii")):
            raise AuthenticationError(response_code=403, log_msg="Screen authorization refused")
