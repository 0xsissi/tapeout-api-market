import base64
import json
import time

import httpx
import pytest
from clawmarket_agent_sdk.client import ClawMarket


POOL = "0x1111111111111111111111111111111111111111"
SELLER = "0x2222222222222222222222222222222222222222"
KEY = "0x" + "33" * 32  # fixture only, never funded
REQUEST = {"model": "test-model", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 128}


def setup_client(stream=False, usage=None, payment_token='USDC', payment_network='default'):
    client = ClawMarket(base_url="http://test", private_key=KEY, escrow_pool_address=POOL, payment_token=payment_token, payment_network=payment_network,
                        max_request_cost_token=10 if payment_token == 'BEM' else None)
    price = 1000 if payment_token == 'BEM' else 100
    price_base = price * client.scale
    input_budget = len(json.dumps(REQUEST["messages"], separators=(",", ":")).encode()) + 32 + 512
    quote = {"buyer": client.buyer_address, "seller": SELLER, "amount": str((input_budget + 128) * price_base // 1000000), "nonce": "1",
             "expiresAt": int(time.time()) + 600, "poolId": "0x" + POOL[2:].rjust(64, "0"), "nonceMode": "bitmap",
             "requestId": "request-test", "payloadHash": "0x" + "00" * 32, "inputPrice": str(price_base), "outputPrice": str(price_base),
             "maxInputTokens": input_budget, "maxOutputTokens": 128}
    prepared = {"preparedRequestId": "prepared-test", "requestId": "request-test", "authorization": quote,
                "provider": {"walletAddress": SELLER, "pricing": {"inputPer1m": price, "outputPer1m": price}},
                "typedData": {"domain": {"name": "ClawInferenceIntent", "chainId": client.chain_id, "verifyingContract": POOL}}}
    if payment_token == 'BEM' or payment_network == 'bsc-testnet':
        prepared['paymentToken'] = {'symbol': payment_token, 'address': client.payment_token_address, 'decimals': client.decimals, 'chainId': client.chain_id, 'minimumAmount': client.minimum_amount}
    receipts = []
    usage = usage or {"prompt_tokens": 1, "completion_tokens": 20, "total_tokens": 21}

    def handle(request):
        if request.url.path.endswith("/prepare"):
            return httpx.Response(200, json=prepared)
        if request.url.path.endswith("/settle"):
            receipts.append(json.loads(request.content)["authorization"])
            return httpx.Response(200, json={"accepted": True})
        token = request.headers["Authorization"].removeprefix("Bearer claw_")
        decoded = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
        assert decoded["authorization"]["signature"] == client._sign_authorization(quote, intent=True)
        assert decoded["authorization"]["signature"] != client._sign_authorization(quote)
        if stream:
            events = [{"choices": [{"delta": {"content": "hello"}}]}, {"choices": [], "usage": usage}, {"clawSettlement": {"preparedRequestId": "prepared-test"}, "usage": usage}]
            body = "".join(f"data: {json.dumps(value)}\n\n" for value in events) + "data: [DONE]\n\n"
            return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "hello"}}], "usage": usage, "clawSettlement": {"preparedRequestId": "prepared-test"}})

    client.http.close()
    client.http = httpx.Client(transport=httpx.MockTransport(handle))
    return client, receipts, prepared


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("payment_network", ['default', 'bsc-testnet'])
def test_confirms_actual_cost_after_delivery(stream, payment_network):
    client, receipts, _ = setup_client(stream, payment_network=payment_network)
    try:
        request = {**REQUEST, "stream": stream}
        result = client.create_chat_completion(request)
        if stream:
            assert list(result)[0]["choices"][0]["delta"]["content"] == "hello"
        else:
            assert result["choices"][0]["message"]["content"] == "hello"
        assert len(receipts) == 1
        assert receipts[0]['signature'].startswith('0x') and len(receipts[0]['signature']) == 132
        assert receipts[0]["amount"] == ("2100" if payment_network == 'bsc-testnet' else "10000")
    finally:
        client.http.close()


def test_bsc_network_must_be_explicit_and_cannot_accept_legacy_payment_metadata():
    with pytest.raises(ValueError, match='selected payment network'):
        ClawMarket(base_url='http://test', private_key=KEY, escrow_pool_address=POOL, chain_id=97)
    client, receipts, prepared = setup_client(payment_network='bsc-testnet')
    try:
        prepared.pop('paymentToken')
        with pytest.raises(ValueError, match='currency'):
            client.create_execution_token(prepared)
        assert receipts == []
    finally:
        client.http.close()


def test_bsc_luna_separate_rates_charge_micro_usdc_after_delivery():
    usage = {'prompt_tokens': 315, 'completion_tokens': 13, 'total_tokens': 328}
    client, receipts, prepared = setup_client(usage=usage, payment_network='bsc-testnet')
    try:
        quote = prepared['authorization']
        prepared['provider']['pricing'].update(inputPer1m=0.02, outputPer1m=0.10)
        quote['inputPrice'] = '20000'
        quote['outputPrice'] = '100000'
        quote['amount'] = str((quote['maxInputTokens'] * 20000 + quote['maxOutputTokens'] * 100000 + 999999) // 1000000)
        client.create_chat_completion(REQUEST)
        assert receipts[0]['amount'] == '8'
        assert client.minimum == 1
    finally:
        client.http.close()


def test_bsc_rejects_legacy_one_cent_floor_metadata():
    client, _, prepared = setup_client(payment_network='bsc-testnet')
    try:
        prepared['paymentToken']['minimumAmount'] = '0.01'
        with pytest.raises(ValueError, match='currency'):
            client.create_execution_token(prepared)
    finally:
        client.http.close()


def test_does_not_sign_out_of_budget_delivery():
    client, receipts, _ = setup_client(usage={"prompt_tokens": 1, "completion_tokens": 1000, "total_tokens": 1001})
    try:
        with pytest.raises(ValueError, match="exceeds intent"):
            client.create_chat_completion(REQUEST)
        assert receipts == []
    finally:
        client.http.close()


def test_rejects_a_spendable_domain_in_prepare():
    client, _, prepared = setup_client()
    try:
        prepared["typedData"]["domain"]["name"] = "ClawEscrowPool"
        with pytest.raises(ValueError, match="Unsafe hosted payment domain"):
            client.create_execution_token(prepared)
    finally:
        client.http.close()


@pytest.mark.parametrize('stream', [False, True])
def test_bem_delivery_uses_eight_decimal_actual_fee(stream):
    client, receipts, _ = setup_client(stream, payment_token='BEM')
    try:
        result = client.create_chat_completion({**REQUEST, 'stream': stream})
        if stream:
            list(result)
        assert len(receipts) == 1
        assert receipts[0]['amount'] == '2100000'  # 0.021 BEM
    finally:
        client.http.close()


def test_bem_rejects_missing_budget_or_wrong_currency():
    with pytest.raises(ValueError, match='BEM requires'):
        ClawMarket(base_url='http://test', private_key=KEY, escrow_pool_address=POOL, payment_token='BEM')
    client, receipts, prepared = setup_client(payment_token='BEM')
    try:
        prepared['paymentToken']['decimals'] = 6
        with pytest.raises(ValueError, match='currency'):
            client.create_chat_completion(REQUEST)
        assert receipts == []
    finally:
        client.http.close()


@pytest.mark.parametrize('base_url,expected', [('http://127.0.0.1:8787', False), ('http://[::1]:8787', False), ('http://localhost:8787', False), ('https://gateway.example', True)])
def test_local_gateway_bypasses_system_proxy(monkeypatch, base_url, expected):
    options = []
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: options.append(kwargs))
    ClawMarket(base_url=base_url, private_key=KEY, escrow_pool_address=POOL)
    assert options[0]['trust_env'] is expected


def test_actual_input_overhead_is_covered_and_oversized_overhead_is_refused():
    client, receipts, _ = setup_client(usage={'prompt_tokens': 315, 'completion_tokens': 9, 'total_tokens': 324})
    try:
        client.create_chat_completion(REQUEST)
        assert receipts[0]['amount'] == '32400'
    finally:
        client.http.close()
    with pytest.raises(ValueError, match='input_overhead_tokens'):
        ClawMarket(base_url='http://test', private_key=KEY, escrow_pool_address=POOL, input_overhead_tokens=8193)
