"""Optional private owner hop, sharing the existing single ViewServer authority.
The mount must be below a host-private 0700 parent. Socket 0666 accommodates
rootless UID translation; no host user can traverse that private parent.
"""
import os
from pathlib import Path
import socketserver
import stat
import threading

class OwnerUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    def __init__(self, path, owner):
        # Share the *same* replay cache, sessions, engine, locks and inbox. Never
        # construct a second engine or persistent-state authority.
        self.__dict__.update(owner.__dict__)
        socketserver.UnixStreamServer.__init__(self, path, owner.RequestHandlerClass)

def start_owner_hop(owner):
    path = os.environ.get('MESSENGER_OWNER_SOCKET')
    if not path:
        return None
    if not owner.trusted_owner.enabled:
        raise ValueError('Owner Unix socket requires trusted owner mode')
    target = Path(path)
    if target.exists():
        if not stat.S_ISSOCK(target.lstat().st_mode):
            raise ValueError('Refusing to replace non-socket owner hop')
        target.unlink()
    server = OwnerUnixServer(path, owner)
    os.chmod(path,0o666)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server
