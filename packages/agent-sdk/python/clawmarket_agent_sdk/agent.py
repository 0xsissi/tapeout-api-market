"""Local management access for an AI; no wallet signing key is required."""
from typing import Any, Dict, Optional
from urllib.parse import urlparse
import httpx


class TAMAgentClient:
    def __init__(self, *, token: str, base_url: str = "http://127.0.0.1:18787", http_client: Optional[httpx.Client] = None) -> None:
        url = urlparse(base_url)
        if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost") or url.username or url.password or not token:
            raise ValueError("TAM Agent requires a local controller URL and management token")
        self.base_url = base_url.rstrip("/")
        self.token = token
        # This credential must stay on the local loopback connection, even when the
        # user's shell has HTTP(S)_PROXY configured for internet access.
        self.http = http_client or httpx.Client(timeout=190.0, trust_env=False)

    def status(self) -> Dict[str, Any]:
        return self._request("/v1/tam/status")

    def tools(self) -> Dict[str, Any]:
        return self._request("/v1/tam/tools")

    def operations(self) -> Dict[str, Any]:
        return self._request("/v1/tam/operations")

    def execute(self, *, id: str, action: str, params: Dict[str, Any], reason: str = "") -> Dict[str, Any]:
        # Never automatically retry; the operation ID is also the recovery lookup key.
        return self._request("/v1/tam/actions", {"id": id, "action": action, "params": params, "reason": reason})

    def invoke(self, id: str, params: Dict[str, Any], reason: str = "") -> Dict[str, Any]:
        return self.execute(id=id, action="invoke", params=params, reason=reason)

    def deposit(self, id: str, amount_token: str, reason: str = "") -> Dict[str, Any]:
        return self.execute(id=id, action="deposit", params={"amountToken": amount_token}, reason=reason)

    def collect(self, id: str, reason: str = "") -> Dict[str, Any]:
        return self.execute(id=id, action="collect", params={}, reason=reason)

    def price(self, id: str, model: str, p0: float, alpha: Optional[float] = None, reason: str = "") -> Dict[str, Any]:
        params: Dict[str, Any] = {"model": model, "p0": p0}
        if alpha is not None:
            params["alpha"] = alpha
        return self.execute(id=id, action="price", params=params, reason=reason)

    def close(self) -> None:
        self.http.close()

    def _request(self, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.token}"}
        response = self.http.get(f"{self.base_url}{path}", headers=headers) if body is None else self.http.post(f"{self.base_url}{path}", headers=headers, json=body)
        response.raise_for_status()
        return response.json()
