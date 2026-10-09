import httpx
import pytest
from clawmarket_agent_sdk import TAMAgentClient


def test_management_uses_token_and_does_not_retry_uncertain_payments():
    requests = []
    def handle(request):
        requests.append(request)
        assert request.headers['Authorization'] == 'Bearer management-token'
        return httpx.Response(200, json={'operation': {'id': 'one', 'status': 'uncertain'}})
    with httpx.Client(transport=httpx.MockTransport(handle)) as http:
        agent = TAMAgentClient(token='management-token', http_client=http)
        result = agent.deposit('one', '0.25', '补充 API 预算')
        assert result['operation']['status'] == 'uncertain'
        assert len(requests) == 1
        assert b'private_key' not in requests[0].content


def test_management_rejects_remote_urls():
    with pytest.raises(ValueError):
        TAMAgentClient(token='management-token', base_url='https://remote.example')
