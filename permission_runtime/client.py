"""Raw negative-test client; no extra capability over the MCP transport."""
from mcp import call as rpc

def call(q, path='/agent/broker.sock'):
    return rpc(path, q)
