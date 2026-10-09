"""One real Hosted Gateway request; credentials arrive only through stdin."""
import json
import sys
from clawmarket_agent_sdk import TAM

config = json.load(sys.stdin)
client = TAM(base_url=config['baseURL'], private_key=config['privateKey'],
             gateway_token=config['gatewayToken'], escrow_pool_address=config['pool'],
             chain_id=97, payment_network='bsc-testnet', payment_token=config['currency'],
             max_request_cost_token=3, timeout=90)
try:
    result = client.chat.completions.create(**config['request'])
    if config['request'].get('stream'):
        text = ''
        usage = None
        for event in result:
            choices = event.get('choices', [])
            if choices:
                text += choices[0].get('delta', {}).get('content', '')
            if event.get('usage'):
                usage = event['usage']
    else:
        text = result['choices'][0]['message']['content']
        usage = result['usage']
    print(json.dumps({'text': text, 'usage': usage}))
finally:
    client.http.close()
