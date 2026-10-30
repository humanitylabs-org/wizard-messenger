"""One bounded JSON RPC over a local capability socket; no HTTP/network client."""
import json
import socket
import sys


def call(request, path='/agent/broker.sock'):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(5)
        s.connect(path)
        s.sendall(json.dumps(request).encode() + b'\n')
        with s.makefile('rb') as f:
            return json.loads(f.readline(65537))


if __name__ == '__main__':
    print(json.dumps(call(json.loads(sys.argv[2]), sys.argv[1]), sort_keys=True))
