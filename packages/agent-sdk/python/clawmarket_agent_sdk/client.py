from __future__ import annotations

import base64
import json
import time
import ipaddress
from urllib.parse import urlsplit
from decimal import Decimal, ROUND_CEILING
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional

import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data


def _b64url_json(value: Dict[str, Any]) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _normalize_private_key(value: str) -> str:
    return value if value.startswith("0x") else f"0x{value}"


def _pool_id_from_address(address: str) -> str:
    return "0x" + address.lower().removeprefix("0x").rjust(64, "0")


@dataclass
class _Completions:
    client: "ClawMarket"

    def create(self, **request: Any) -> Any:
        return self.client.create_chat_completion(request)


@dataclass
class _Chat:
    client: "ClawMarket"

    @property
    def completions(self) -> _Completions:
        return _Completions(self.client)


class ClawMarket:
    """Small OpenAI-shaped client for the Tapeout API Market (TAM) Hosted Gateway."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: Optional[str] = None,
        private_key: Optional[str] = None,
        escrow_pool_address: str,
        chain_id: Optional[int] = None,
        timeout: float = 60.0,
        max_retries: int = 1,
        gateway_token: Optional[str] = None,
        max_request_cost_usd: float = 0.1,
        payment_token: str = 'USDC',
        payment_network: str = 'default',
        max_request_cost_token: Optional[float] = None,
        input_overhead_tokens: int = 512,
        trust_env: Optional[bool] = None,
    ) -> None:
        key = private_key or api_key
        if not key:
            raise ValueError("Tapeout API Market (TAM) requires private_key or api_key")
        self.base_url = base_url.rstrip("/")
        if type(input_overhead_tokens) is not int or not 0 <= input_overhead_tokens <= 8192:
            raise ValueError('input_overhead_tokens must be an integer between 0 and 8192')
        self.input_overhead_tokens = input_overhead_tokens
        self.private_key = _normalize_private_key(key)
        self.escrow_pool_address = escrow_pool_address
        if payment_token not in ('USDC', 'BEM'):
            raise ValueError('payment_token must be USDC or BEM')
        if payment_network not in ('default', 'bsc-testnet'):
            raise ValueError('payment_network must be default or bsc-testnet')
        self.payment_network = payment_network
        self.payment_token = payment_token
        self.decimals = 8 if payment_token == 'BEM' else 6
        self.scale = 10 ** self.decimals
        self.minimum_amount = '0.000001' if payment_network == 'bsc-testnet' and payment_token == 'USDC' else '0.01'
        self.minimum = int(Decimal(self.minimum_amount) * self.scale)
        expected_chain = 97 if payment_network == 'bsc-testnet' else (56 if payment_token == 'BEM' else 84532)
        self.chain_id = chain_id if chain_id is not None else expected_chain
        if (payment_token == 'BEM' or expected_chain == 97 or self.chain_id == 97) and self.chain_id != expected_chain:
            raise ValueError(f'{payment_token} requires chain {expected_chain} for the selected payment network')
        if payment_token == 'BEM' and max_request_cost_token is None:
            raise ValueError('BEM requires max_request_cost_token in BEM units')
        self.payment_token_address = (
            ('0x6dd0be28736f638844499b019dbaacc5897daac2' if payment_token == 'BEM' else '0xfcc26b50731525a4452d0ed428cdf11058723b89')
            if payment_network == 'bsc-testnet' else
            ('0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a' if payment_token == 'BEM' else '0xcf0819eb156d6c6c1c5d9a515e351d2d1aefff7d')
        )
        self.max_retries = max_retries
        self.gateway_token = gateway_token
        budget = Decimal(str(max_request_cost_token if max_request_cost_token is not None else max_request_cost_usd))
        if not budget.is_finite() or budget <= 0 or budget * self.scale != (budget * self.scale).to_integral_value():
            raise ValueError('Invalid payment budget or precision')
        self.max_cost_micro = int(budget * self.scale)
        self.account = Account.from_key(self.private_key)
        # Windows system proxies may route localhost through an external proxy.
        hostname = urlsplit(self.base_url).hostname
        loopback = hostname == 'localhost'
        try:
            loopback = loopback or ipaddress.ip_address(hostname or '').is_loopback
        except ValueError:
            pass
        self.http = httpx.Client(timeout=timeout, trust_env=not loopback if trust_env is None else trust_env)
        self.chat = _Chat(self)

    @property
    def buyer_address(self) -> str:
        return self.account.address

    def models(self) -> Dict[str, Any]:
        response = self.http.get(f"{self.base_url}/v1/models")
        response.raise_for_status()
        return response.json()

    def prepare_chat_completion(self, request: Dict[str, Any]) -> Dict[str, Any]:
        response = self.http.post(
            f"{self.base_url}/v1/claw/prepare",
            json={"buyer": self.buyer_address, "request": request},
        )
        response.raise_for_status()
        return response.json()

    def estimate_cost(self, request: Dict[str, Any]) -> Dict[str, Any]:
        return self.prepare_chat_completion(request)

    def create_execution_token(self, prepared: Dict[str, Any]) -> str:
        self._validate_payment_token(prepared)
        domain = prepared.get("typedData", {}).get("domain", {})
        quote = prepared["authorization"]
        if domain.get("name") != "ClawInferenceIntent" or domain.get("chainId") != self.chain_id or domain.get("verifyingContract", "").lower() != self.escrow_pool_address.lower():
            raise ValueError("Unsafe hosted payment domain")
        if quote["buyer"].lower() != self.buyer_address.lower() or quote["poolId"].lower() != _pool_id_from_address(self.escrow_pool_address) or quote["nonceMode"] != "bitmap" or int(quote["amount"]) > self.max_cost_micro:
            raise ValueError("Unsafe payment intent")
        signature = self._sign_authorization(prepared["authorization"], intent=True)
        token = {
            "preparedRequestId": prepared["preparedRequestId"],
            "authorization": {
                **prepared["authorization"],
                "signature": signature,
            },
        }
        return f"claw_{_b64url_json(token)}"

    def create_chat_completion(self, request: Dict[str, Any]) -> Any:
        if request.get("stream") is True:
            return self._create_stream(request)
        last_error: Optional[httpx.HTTPStatusError] = None
        for attempt in range(self.max_retries + 1):
            prepared = self.prepare_chat_completion(request)
            self._validate_prepared(prepared, request)
            execute_token = self.create_execution_token(prepared)
            response = self.http.post(
                f"{self.base_url}/v1/chat/completions",
                headers={"Authorization": f"Bearer {execute_token}"},
                json=request,
            )
            if response.is_success:
                if request.get("stream") is True:
                    return self._iter_sse(response.iter_lines())
                result = response.json()
                if not result.get("choices", [{}])[0].get("message", {}).get("content", "").strip():
                    raise ValueError("Empty delivery")
                self._confirm_delivery(prepared, result)
                result.pop("clawSettlement", None)
                return result

            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as error:
                last_error = error
            if attempt >= self.max_retries or not self._should_retry(response):
                raise last_error or httpx.HTTPStatusError(
                    "Hosted Gateway request failed",
                    request=response.request,
                    response=response,
                )
        raise RuntimeError("Hosted Gateway request failed")

    def deposit_with_permit(self, permit: Dict[str, Any]) -> Dict[str, Any]:
        if self.payment_token == 'BEM':
            raise ValueError('Use wallet approve + deposit for BEM; permit support has not been verified')
        response = self.http.post(f"{self.base_url}/v1/claw/deposit/permit", json=permit, headers={"Authorization": f"Bearer {self.gateway_token}"} if self.gateway_token else {})
        response.raise_for_status()
        return response.json()

    def _validate_payment_token(self, prepared: Dict[str, Any]) -> None:
        token = prepared.get('paymentToken')
        if token is None and self.payment_token == 'USDC' and self.payment_network == 'default':
            return
        address = self.payment_token_address
        if not token or token.get('symbol') != self.payment_token or token.get('address', '').lower() != address or token.get('decimals') != self.decimals or token.get('chainId') != self.chain_id or token.get('minimumAmount') != self.minimum_amount:
            raise ValueError('Hosted gateway settlement currency does not match buyer configuration')

    def _sign_authorization(self, quote: Dict[str, Any], intent: bool = False) -> str:
        domain = {
            "name": "ClawEscrowPool",
            "version": "1",
            "chainId": self.chain_id,
            "verifyingContract": self.escrow_pool_address,
        }
        typed_data = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "Authorization": [
                    {"name": "buyer", "type": "address"},
                    {"name": "seller", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "nonce", "type": "uint256"},
                    {"name": "expiresAt", "type": "uint256"},
                    {"name": "poolId", "type": "bytes32"},
                    {"name": "nonceMode", "type": "uint8"},
                ],
            },
            "primaryType": "Authorization",
            "domain": domain,
            "message": {
                "buyer": quote["buyer"],
                "seller": quote["seller"],
                "amount": int(quote["amount"]),
                "nonce": int(quote["nonce"]),
                "expiresAt": int(quote["expiresAt"]),
                "poolId": quote.get("poolId") or _pool_id_from_address(self.escrow_pool_address),
                "nonceMode": 1,
            },
        }
        if intent:
            typed_data["domain"]["name"] = "ClawInferenceIntent"
            fields = [
                {"name": "requestId", "type": "string"}, {"name": "payloadHash", "type": "bytes32"},
                {"name": "inputPrice", "type": "uint256"}, {"name": "outputPrice", "type": "uint256"},
                {"name": "maxInputTokens", "type": "uint256"}, {"name": "maxOutputTokens", "type": "uint256"},
            ]
            typed_data["types"]["InferenceIntent"] = typed_data["types"].pop("Authorization") + fields
            typed_data["primaryType"] = "InferenceIntent"
            typed_data["message"].update({field["name"]: int(quote[field["name"]]) if field["type"] == "uint256" else quote[field["name"]] for field in fields})
        message = encode_typed_data(full_message=typed_data)
        signed = Account.sign_message(message, private_key=self.private_key)
        return '0x' + signed.signature.hex().removeprefix('0x')

    def _validate_prepared(self, prepared: Dict[str, Any], request: Dict[str, Any]) -> None:
        self._validate_payment_token(prepared)
        quote = prepared["authorization"]
        messages = request.get("messages", [])
        input_budget = len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 32 * len(messages) + self.input_overhead_tokens
        pricing = prepared["provider"]["pricing"]
        input_price = int((Decimal(str(pricing["inputPer1m"])) * self.scale).to_integral_value(rounding=ROUND_CEILING))
        output_price = int((Decimal(str(pricing["outputPer1m"])) * self.scale).to_integral_value(rounding=ROUND_CEILING))
        output_budget = request.get("max_tokens", 1024)
        amount = max(self.minimum, (input_budget * input_price + output_budget * output_price + 999999) // 1000000)
        if quote["requestId"] != prepared["requestId"] or quote["seller"].lower() != prepared["provider"]["walletAddress"].lower() or quote["maxInputTokens"] != input_budget or quote["maxOutputTokens"] != output_budget or int(quote["inputPrice"]) != input_price or int(quote["outputPrice"]) != output_price or int(quote["amount"]) != amount:
            raise ValueError("Hosted intent does not match request budget")

    def _confirm_delivery(self, prepared: Dict[str, Any], result: Dict[str, Any]) -> None:
        metadata = result.get("clawSettlement", {})
        if metadata.get("preparedRequestId") != prepared["preparedRequestId"]:
            raise ValueError("Settlement request mismatch")
        quote = prepared["authorization"]
        usage = result.get("usage") or {}
        prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
        if any(type(n) is not int or n < 0 for n in (prompt, completion)) or type(usage.get("total_tokens")) is not int or usage.get("total_tokens") != prompt + completion:
            raise ValueError("Invalid usage")
        if prompt > quote["maxInputTokens"] or completion > quote["maxOutputTokens"]:
            raise ValueError("Usage exceeds intent")
        amount = max(self.minimum, (prompt * int(quote["inputPrice"]) + completion * int(quote["outputPrice"]) + 999999) // 1000000)
        if amount > int(quote["amount"]):
            raise ValueError("Payment exceeds budget")
        final = {key: quote[key] for key in ("buyer", "seller", "amount", "nonce", "expiresAt", "poolId", "nonceMode")}
        final["amount"] = str(amount)
        final["signature"] = self._sign_authorization(final)
        response = self.http.post(f"{self.base_url}/v1/claw/settle", json={"preparedRequestId": prepared["preparedRequestId"], "authorization": final})
        response.raise_for_status()

    def _create_stream(self, request: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
        prepared = self.prepare_chat_completion(request)
        self._validate_prepared(prepared, request)
        token = self.create_execution_token(prepared)
        content = ""
        settled = False
        with self.http.stream("POST", f"{self.base_url}/v1/chat/completions", headers={"Authorization": f"Bearer {token}"}, json=request) as response:
            response.raise_for_status()
            for value in self._iter_sse(response.iter_lines()):
                if "error" in value:
                    raise ValueError(value["error"].get("message", "Delivery failed"))
                choices = value.get("choices") or [{}]
                content += choices[0].get("delta", {}).get("content", "")
                if "clawSettlement" in value:
                    if not content.strip():
                        raise ValueError("Empty delivery")
                    self._confirm_delivery(prepared, value)
                    settled = True
                else:
                    yield value
        if not settled:
            raise ValueError("Stream ended without delivery confirmation")

    @staticmethod
    def _iter_sse(lines: Iterable[str]) -> Iterable[Dict[str, Any]]:
        for line in lines:
            if not line.startswith("data: "):
                continue
            data = line[len("data: ") :]
            if data == "[DONE]":
                break
            yield json.loads(data)

    @staticmethod
    def _should_retry(response: httpx.Response) -> bool:
        if response.status_code == 429:
            return True
        try:
            return response.json().get("error", {}).get("type") == "backpressure_soft_reject"
        except Exception:
            return False
